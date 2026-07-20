import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HtmlExtractor } from '../../src/agents/rag/ingestion/extractors/html.extractor';
import { PdfExtractor } from '../../src/agents/rag/ingestion/extractors/pdf.extractor';
import { UnprocessableDocumentError } from '../../src/agents/rag/ingestion/extractors/extractor.types';

const fixture = (name: string) =>
  resolve(__dirname, '..', 'fixtures', 'rag', name);

describe('PdfExtractor', () => {
  const extractor = new PdfExtractor();

  it('extracts the text layer from a real PDF', async () => {
    const data = readFileSync(fixture('sample.pdf'));
    const result = await extractor.extract(data, 'sample.pdf');

    expect(result.sourceType).toBe('pdf');
    expect(result.sourceName).toBe('sample.pdf');
    expect(result.text).toContain('Cortist Test Document');
    expect(result.text).toContain('4.2 million');
    expect(result.text).toContain('19 people');
  });

  it('rejects a file that is not a PDF', async () => {
    // Retrying cannot fix this, which is why it is UnprocessableDocumentError
    // rather than a plain Error.
    await expect(
      extractor.extract(Buffer.from('this is plainly not a pdf'), 'fake.pdf'),
    ).rejects.toThrow(UnprocessableDocumentError);
  });

  it('rejects a truncated PDF', async () => {
    const data = readFileSync(fixture('sample.pdf')).subarray(0, 200);
    await expect(extractor.extract(data, 'broken.pdf')).rejects.toThrow(
      UnprocessableDocumentError,
    );
  });

  it('explains itself in plain language for the user', async () => {
    try {
      await extractor.extract(Buffer.from('nope'), 'report.pdf');
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(UnprocessableDocumentError);
      const userMessage = (error as UnprocessableDocumentError).userMessage;
      expect(userMessage).toContain('report.pdf');
      // No stack traces or library internals in something a user reads.
      expect(userMessage).not.toContain('Error:');
    }
  });
});

describe('HtmlExtractor', () => {
  const extractor = new HtmlExtractor();
  const url = 'https://example.com/vector-databases';

  it('keeps the article text', async () => {
    const html = readFileSync(fixture('sample-article.html'), 'utf8');
    const result = await extractor.extract(html, url);

    expect(result.sourceType).toBe('url');
    expect(result.text).toContain('vector database stores high-dimensional');
    expect(result.text).toContain('HNSW builds a navigable small-world graph');
  });

  it('strips the navigation, cookie banner, sidebar, and footer', async () => {
    // This is the whole point of using Readability over a raw dump: boilerplate
    // is near-identical across a site's pages, so embedding it fills the store
    // with chunks that match queries for entirely the wrong reasons.
    const html = readFileSync(fixture('sample-article.html'), 'utf8');
    const result = await extractor.extract(html, url);

    expect(result.text).not.toContain('Accept all cookies');
    expect(result.text).not.toContain('Contact Us Today');
    expect(result.text).not.toContain('All rights reserved');
    expect(result.text).not.toContain('Subscribe to our newsletter');
    expect(result.text).not.toContain('window.analytics');
  });

  it('uses the article title in the source name, for a readable citation', async () => {
    const html = readFileSync(fixture('sample-article.html'), 'utf8');
    const result = await extractor.extract(html, url);

    expect(result.sourceName).toContain('Understanding Vector Databases');
    expect(result.sourceName).toContain(url);
  });

  it('rejects a page with no readable content', async () => {
    // The shape of a client-rendered app: an empty shell that needs JavaScript.
    const shell =
      '<!doctype html><html><body><div id="root"></div></body></html>';

    await expect(extractor.extract(shell, url)).rejects.toThrow(
      UnprocessableDocumentError,
    );
  });

  it('falls back to body text when Readability finds no article', async () => {
    // Not every saved page is an article. A dashboard or listing is still worth
    // remembering, so declining outright would be wrong.
    const listing = `<!doctype html><html><body><main>
      ${'Item one. Item two. Item three. Something worth keeping about the topic. '.repeat(4)}
    </main></body></html>`;

    const result = await extractor.extract(listing, url);
    expect(result.text).toContain('Something worth keeping');
  });
});
