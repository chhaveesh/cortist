/**
 * Recursive text chunker.
 *
 * Sizes are in **characters, not tokens**. Counting real tokens would mean
 * either a vendor round trip per chunk or bundling a BPE tokenizer, and at v1
 * the precision buys nothing — the chunk boundary only needs to be roughly
 * right for retrieval to work. ~4 characters per token is the usual English
 * approximation, so the defaults below are about 500 tokens with 50 of overlap.
 *
 * Explicitly a tuning target: chunk size, overlap, and whether to count real
 * tokens are all worth revisiting once there is retrieval quality to measure.
 */

export interface ChunkOptions {
  /** Target maximum characters per chunk. */
  maxChars?: number;
  /** Characters repeated from the end of the previous chunk. */
  overlapChars?: number;
}

export const DEFAULT_MAX_CHARS = 2000;
export const DEFAULT_OVERLAP_CHARS = 200;

/**
 * Separators tried in order, coarsest first. Splitting on a paragraph break
 * keeps related sentences together; falling back to a sentence, then a word,
 * degrades gracefully rather than slicing mid-word.
 */
const SEPARATORS = ['\n\n', '\n', '. ', ' '];

export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;

  if (maxChars <= 0) throw new Error('maxChars must be positive');
  if (overlapChars < 0) throw new Error('overlapChars must not be negative');
  // Overlap at or above chunk size would make each chunk start where the last
  // one did, and the loop would never advance.
  if (overlapChars >= maxChars) {
    throw new Error('overlapChars must be smaller than maxChars');
  }

  const normalized = normalizeWhitespace(text);
  if (normalized.length === 0) return [];
  if (normalized.length <= maxChars) return [normalized];

  const pieces = splitRecursively(normalized, maxChars, 0);
  return mergeWithOverlap(pieces, maxChars, overlapChars);
}

/**
 * Collapses the whitespace noise that PDF and HTML extraction leave behind.
 * Paragraph breaks are preserved because the chunker splits on them.
 */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Rejoins lines wrapped mid-sentence, while keeping paragraph breaks.
 *
 * PDF and HTML extraction preserve the source's line wrapping, so a sentence
 * arrives split across several lines. Left alone, a phrase spanning a wrap
 * contains a newline where a reader expects a space — which breaks phrase
 * matching and puts spurious boundaries into the text an embedding model sees.
 *
 * Run after `normalizeWhitespace`, which has already reduced paragraph gaps to
 * exactly two newlines.
 */
export function joinWrappedLines(text: string): string {
  return text.replace(/(?<!\n)\n(?!\n)/g, ' ');
}

/**
 * Splits until every piece fits, trying progressively finer separators. A
 * segment with no usable separator left (one enormous unbroken string) is cut
 * at the size limit — losing a word boundary beats emitting an oversized chunk
 * the embedding model would silently truncate.
 */
function splitRecursively(
  text: string,
  maxChars: number,
  separatorIndex: number,
): string[] {
  if (text.length <= maxChars) return [text];

  if (separatorIndex >= SEPARATORS.length) {
    const hard: string[] = [];
    for (let i = 0; i < text.length; i += maxChars) {
      hard.push(text.slice(i, i + maxChars));
    }
    return hard;
  }

  const separator = SEPARATORS[separatorIndex];
  const parts = text.split(separator);

  // This separator does not occur — try the next one rather than looping.
  if (parts.length === 1) {
    return splitRecursively(text, maxChars, separatorIndex + 1);
  }

  const result: string[] = [];
  for (const [index, part] of parts.entries()) {
    // Put the separator back, so sentences keep their full stop and paragraphs
    // keep their break.
    const piece = index < parts.length - 1 ? part + separator : part;
    if (piece.length === 0) continue;

    result.push(
      ...(piece.length > maxChars
        ? splitRecursively(piece, maxChars, separatorIndex + 1)
        : [piece]),
    );
  }

  return result;
}

/**
 * Packs pieces up to the size limit, then starts the next chunk with the tail
 * of the previous one.
 *
 * The overlap is what stops a fact that straddles a boundary from being
 * unretrievable: without it, a sentence split across two chunks appears whole
 * in neither.
 */
function mergeWithOverlap(
  pieces: string[],
  maxChars: number,
  overlapChars: number,
): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const piece of pieces) {
    if (current.length > 0 && current.length + piece.length > maxChars) {
      chunks.push(current.trim());

      // Carry the overlap forward — but only when the next piece still fits
      // alongside it. A piece that is already at the size limit (the hard-split
      // case, where every piece is exactly maxChars) would otherwise produce
      // overlap + maxChars and overflow the limit the caller was promised.
      // Losing the overlap on that chunk is the lesser cost: an oversized chunk
      // gets silently truncated by the embedding model.
      const overlap = overlapChars > 0 ? tailOf(current, overlapChars) : '';
      current = overlap.length + piece.length <= maxChars ? overlap : '';
    }
    current += piece;
  }

  if (current.trim().length > 0) chunks.push(current.trim());

  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * The last `overlapChars` of a chunk, rewound to a word boundary so the overlap
 * does not begin mid-word.
 */
function tailOf(text: string, overlapChars: number): string {
  const tail = text.slice(-overlapChars);
  const boundary = tail.search(/\s/);
  return boundary === -1 ? tail : tail.slice(boundary + 1);
}
