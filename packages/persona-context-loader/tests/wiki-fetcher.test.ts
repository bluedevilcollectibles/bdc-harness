import { describe, test, expect } from 'bun:test';
import { WikiFetchError } from '../src/wiki-fetcher';

describe('fetchWikiPath path validation', () => {
  test('path traversal throws WikiFetchError with code path_traversal', async () => {
    const { fetchWikiPath } = await import('../src/wiki-fetcher');
    let err: WikiFetchError | null = null;
    try {
      await fetchWikiPath('../etc/passwd', 'token');
    } catch (e) {
      err = e as WikiFetchError;
    }
    expect(err).not.toBeNull();
    expect(err?.code).toBe('path_traversal');
  });

  test('forbidden path pattern throws WikiFetchError with code forbidden_path', async () => {
    const { fetchWikiPath } = await import('../src/wiki-fetcher');
    let err: WikiFetchError | null = null;
    try {
      await fetchWikiPath('docs/secrets/api-keys.md', 'token');
    } catch (e) {
      err = e as WikiFetchError;
    }
    expect(err).not.toBeNull();
    expect(err?.code).toBe('forbidden_path');
  });

  test('deploy path pattern is rejected', async () => {
    const { fetchWikiPath } = await import('../src/wiki-fetcher');
    let err: WikiFetchError | null = null;
    try {
      await fetchWikiPath('docs/deploy-scripts/', 'token');
    } catch (e) {
      err = e as WikiFetchError;
    }
    expect(err).not.toBeNull();
    expect(err?.code).toBe('forbidden_path');
  });

  test('credentials path pattern is rejected', async () => {
    const { fetchWikiPath } = await import('../src/wiki-fetcher');
    let err: WikiFetchError | null = null;
    try {
      await fetchWikiPath('docs/credentials.md', 'token');
    } catch (e) {
      err = e as WikiFetchError;
    }
    expect(err).not.toBeNull();
    expect(err?.code).toBe('forbidden_path');
  });
});
