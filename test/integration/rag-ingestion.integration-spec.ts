import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RagHarness,
  buildRagJob,
  createRagHarness,
  destroyRagHarness,
  resetRagState,
  routeToRag,
  seedRagTenant,
} from '../rag-harness';

const fixture = (name: string) =>
  readFileSync(resolve(__dirname, '..', 'fixtures', 'rag', name));

describe('RAG ingestion (integration)', () => {
  let harness: RagHarness;
  let tenantId: string;

  beforeAll(async () => {
    harness = await createRagHarness();
  });

  afterAll(async () => {
    await destroyRagHarness(harness);
  });

  beforeEach(async () => {
    await resetRagState(harness);
    tenantId = await seedRagTenant(harness, 710_000_001);
  });

  describe('pasted text', () => {
    it('stores a document and its chunks, and confirms with a summary and tags', async () => {
      harness.llm.scriptIntent({
        intent: 'store',
        confidence: 'high',
        content: 'The API rate limit is 1000 requests per minute per key.',
      });
      harness.llm.setSummary({
        summary: 'Notes on API rate limiting.',
        tags: ['api', 'limits'],
      });

      const outcome = await routeToRag(
        harness,
        buildRagJob(
          tenantId,
          'save this: The API rate limit is 1000 requests per minute per key.',
        ),
      );

      expect(outcome.status).toBe('ingested');

      const documents = await harness.prisma.document.findMany({
        where: { userId: tenantId },
      });
      expect(documents).toHaveLength(1);
      expect(documents[0].sourceType).toBe('text');
      expect(documents[0].summary).toBe('Notes on API rate limiting.');
      expect(documents[0].tags).toEqual(['api', 'limits']);

      const chunks = await harness.prisma.documentChunk.findMany({
        where: { documentId: documents[0].id },
      });
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].userId).toBe(tenantId);
      expect(chunks[0].content).toContain('1000 requests per minute');

      // The user is told what was saved, not just that something was.
      expect(harness.telegram.transcript).toContain(
        'Notes on API rate limiting',
      );
      expect(harness.telegram.transcript).toContain('api');
    });

    it('embeds chunks as documents, not as queries', async () => {
      // Retrieval quality depends on this distinction for providers that use
      // it, so getting it backwards degrades results silently.
      harness.llm.scriptIntent({
        intent: 'store',
        confidence: 'high',
        content: 'Something worth remembering about the system.',
      });

      await routeToRag(harness, buildRagJob(tenantId, 'remember this: ...'));

      expect(harness.embeddings.calls[0].inputType).toBe('document');
    });

    it('writes a chunk per slice, numbered in order', async () => {
      const long = Array.from(
        { length: 40 },
        (_, i) =>
          `Paragraph ${i} with enough words in it to take up real space.`,
      ).join('\n\n');

      harness.llm.scriptIntent({
        intent: 'store',
        confidence: 'high',
        content: long,
      });

      await routeToRag(harness, buildRagJob(tenantId, 'save this: ...'));

      const chunks = await harness.prisma.documentChunk.findMany({
        where: { userId: tenantId },
        orderBy: { chunkIndex: 'asc' },
      });

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.map((c) => c.chunkIndex)).toEqual(
        chunks.map((_, index) => index),
      );
    });
  });

  describe('uploaded files', () => {
    it('ingests a real PDF end to end', async () => {
      harness.files.register('file-pdf-1', fixture('sample.pdf'));

      const outcome = await routeToRag(
        harness,
        buildRagJob(tenantId, '', {
          attachment: {
            fileId: 'file-pdf-1',
            fileName: 'sample.pdf',
            mimeType: 'application/pdf',
          },
        }),
      );

      expect(outcome.status).toBe('ingested');

      const chunks = await harness.prisma.documentChunk.findMany({
        where: { userId: tenantId },
      });
      expect(chunks.map((c) => c.content).join(' ')).toContain('4.2 million');

      // An upload is unambiguous, so no classification is spent on it.
      expect(harness.llm.classifyCalls).toEqual([]);
    });

    it('ingests a plain text file', async () => {
      harness.files.register(
        'file-txt-1',
        'Meeting notes: ship the thing on Friday.',
      );

      const outcome = await routeToRag(
        harness,
        buildRagJob(tenantId, '', {
          attachment: {
            fileId: 'file-txt-1',
            fileName: 'notes.txt',
            mimeType: 'text/plain',
          },
        }),
      );

      expect(outcome.status).toBe('ingested');
      const docs = await harness.prisma.document.findMany({
        where: { userId: tenantId },
      });
      expect(docs[0].sourceType).toBe('text');
      expect(docs[0].sourceName).toBe('notes.txt');
    });

    it('refuses an unsupported file type without downloading it', async () => {
      const outcome = await routeToRag(
        harness,
        buildRagJob(tenantId, '', {
          attachment: {
            fileId: 'file-zip',
            fileName: 'archive.zip',
            mimeType: 'application/zip',
          },
        }),
      );

      expect(outcome.status).toBe('rejected');
      expect(harness.files.downloaded).toEqual([]);
      expect(harness.telegram.transcript).toContain('archive.zip');
      expect(await harness.prisma.document.count()).toBe(0);
    });

    it('refuses an oversized file before spending a download', async () => {
      // Telegram refuses bot downloads above 20MB anyway, so the request would
      // only produce a worse error.
      const outcome = await routeToRag(
        harness,
        buildRagJob(tenantId, '', {
          attachment: {
            fileId: 'file-big',
            fileName: 'huge.pdf',
            mimeType: 'application/pdf',
            fileSize: 25 * 1024 * 1024,
          },
        }),
      );

      expect(outcome.status).toBe('rejected');
      expect(harness.files.downloaded).toEqual([]);
      expect(harness.telegram.transcript).toContain('20 MB');
    });

    it('reports an unreadable PDF to the user and stores nothing', async () => {
      harness.files.register('file-bad', Buffer.from('not really a pdf'));

      const outcome = await routeToRag(
        harness,
        buildRagJob(tenantId, '', {
          attachment: {
            fileId: 'file-bad',
            fileName: 'broken.pdf',
            mimeType: 'application/pdf',
          },
        }),
      );

      expect(outcome.status).toBe('rejected');
      expect(await harness.prisma.document.count()).toBe(0);
      // Plain language, and it names the file.
      expect(harness.telegram.transcript).toContain('broken.pdf');
    });
  });

  describe('URLs', () => {
    it('fetches a page, strips it to readable text, and stores it', async () => {
      const html = readFileSync(
        resolve(__dirname, '..', 'fixtures', 'rag', 'sample-article.html'),
        'utf8',
      );
      harness.urls.register('https://example.com/vectors', html);

      harness.llm.scriptIntent({
        intent: 'store',
        confidence: 'high',
        content: 'save this https://example.com/vectors',
      });

      const outcome = await routeToRag(
        harness,
        buildRagJob(tenantId, 'save this https://example.com/vectors'),
      );

      expect(outcome.status).toBe('ingested');

      const docs = await harness.prisma.document.findMany({
        where: { userId: tenantId },
      });
      expect(docs[0].sourceType).toBe('url');
      expect(docs[0].sourceName).toContain('Understanding Vector Databases');

      const content = (
        await harness.prisma.documentChunk.findMany({
          where: { userId: tenantId },
        })
      )
        .map((c) => c.content)
        .join(' ');

      expect(content).toContain('vector database stores high-dimensional');
      // Boilerplate must not reach the store — it matches queries for the
      // wrong reasons and is near-identical across a site's pages.
      expect(content).not.toContain('Accept all cookies');
      expect(content).not.toContain('All rights reserved');
    });

    it('reports an unreachable URL without storing anything', async () => {
      harness.urls.failNext("I couldn't reach https://example.com/gone.");
      harness.llm.scriptIntent({
        intent: 'store',
        confidence: 'high',
        content: 'save https://example.com/gone',
      });

      const outcome = await routeToRag(
        harness,
        buildRagJob(tenantId, 'save https://example.com/gone'),
      );

      expect(outcome.status).toBe('rejected');
      expect(await harness.prisma.document.count()).toBe(0);
      expect(harness.telegram.transcript).toContain("couldn't reach");
    });
  });

  it('skips a message that is not about stored knowledge', async () => {
    harness.llm.scriptIntent({ intent: 'not_rag_related', confidence: 'high' });

    const outcome = await routeToRag(
      harness,
      buildRagJob(tenantId, 'what is the capital of France?'),
    );

    expect(outcome).toEqual({ status: 'skipped', reason: 'not_rag_related' });
    expect(harness.telegram.sent).toEqual([]);
  });
});
