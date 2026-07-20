import {
  DEFAULT_MAX_CHARS,
  DEFAULT_OVERLAP_CHARS,
  chunkText,
  normalizeWhitespace,
} from '../../src/agents/rag/ingestion/chunker';

/** Deterministic filler of a requested length, with real word boundaries. */
function words(count: number): string {
  return Array.from({ length: count }, (_, i) => `word${i}`).join(' ');
}

function paragraphs(count: number, wordsEach = 60): string {
  return Array.from({ length: count }, () => words(wordsEach)).join('\n\n');
}

describe('chunkText', () => {
  it('returns nothing for empty or whitespace-only input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  \t ')).toEqual([]);
  });

  it('returns a single chunk for text below the limit', () => {
    const text = 'A short note worth remembering.';
    expect(chunkText(text)).toEqual([text]);
  });

  it('splits long text into multiple chunks', () => {
    const chunks = chunkText(paragraphs(20));
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('keeps every chunk within the size limit', () => {
    // The invariant that matters: an oversized chunk gets silently truncated by
    // the embedding model, losing content with no error anywhere.
    const chunks = chunkText(paragraphs(40));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
    }
  });

  it('loses no words across the split', () => {
    const text = paragraphs(15);
    const chunks = chunkText(text);

    const originalWords = new Set(text.split(/\s+/).filter(Boolean));
    const chunkedWords = new Set(
      chunks.flatMap((chunk) => chunk.split(/\s+/)).filter(Boolean),
    );

    for (const word of originalWords) {
      expect(chunkedWords.has(word)).toBe(true);
    }
  });

  it('overlaps consecutive chunks', () => {
    // Without overlap a fact straddling a boundary appears whole in neither
    // chunk, and becomes unretrievable.
    const chunks = chunkText(paragraphs(30));
    expect(chunks.length).toBeGreaterThan(1);

    const tailWords = chunks[0].split(/\s+/).slice(-8);
    const nextChunkStart = chunks[1].slice(0, DEFAULT_OVERLAP_CHARS + 50);

    expect(tailWords.some((word) => nextChunkStart.includes(word))).toBe(true);
  });

  it('honours custom size and overlap', () => {
    const chunks = chunkText(words(400), { maxChars: 200, overlapChars: 40 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200);
  });

  it('splits an unbroken string with no separators at all', () => {
    // A minified blob or a long base64 line has no paragraph, sentence, or word
    // boundary to split on. Cutting mid-token beats emitting one huge chunk.
    const blob = 'x'.repeat(5000);
    const chunks = chunkText(blob, { maxChars: 500, overlapChars: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
    expect(chunks.join('').replace(/\s/g, '').length).toBeGreaterThanOrEqual(
      5000,
    );
  });

  it('produces no empty or whitespace-only chunks', () => {
    const chunks = chunkText(paragraphs(10).replace(/\n\n/g, '\n\n\n\n'));
    for (const chunk of chunks) expect(chunk.trim().length).toBeGreaterThan(0);
  });

  it('prefers paragraph boundaries when they fit', () => {
    const first = words(100);
    const second = words(100);
    const chunks = chunkText(`${first}\n\n${second}`, {
      maxChars: 900,
      overlapChars: 50,
    });

    // Each paragraph is ~700 chars, so they should not be merged into one.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toContain('word0');
  });

  it.each([
    ['zero maxChars', { maxChars: 0 }],
    ['negative overlap', { overlapChars: -1 }],
    ['overlap equal to maxChars', { maxChars: 100, overlapChars: 100 }],
    ['overlap larger than maxChars', { maxChars: 100, overlapChars: 200 }],
  ])('rejects invalid options: %s', (_name, options) => {
    // Overlap >= size would make each chunk start where the previous one did,
    // and the loop would never advance.
    expect(() => chunkText(words(500), options)).toThrow();
  });
});

describe('normalizeWhitespace', () => {
  it('collapses the whitespace noise PDF extraction leaves behind', () => {
    expect(normalizeWhitespace('a   b\t\tc')).toBe('a b c');
  });

  it('preserves paragraph breaks, since chunking splits on them', () => {
    expect(normalizeWhitespace('para one\n\npara two')).toBe(
      'para one\n\npara two',
    );
  });

  it('collapses runs of blank lines', () => {
    expect(normalizeWhitespace('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('normalises CRLF', () => {
    expect(normalizeWhitespace('a\r\nb')).toBe('a\nb');
  });

  it('trims the ends', () => {
    expect(normalizeWhitespace('\n\n  hello  \n\n')).toBe('hello');
  });
});
