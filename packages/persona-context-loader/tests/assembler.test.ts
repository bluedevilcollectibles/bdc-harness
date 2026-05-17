import { describe, test, expect } from 'bun:test';
import { assembleContext } from '../src/assembler';
import type { WikiFetchResult, OracleFetchResult } from '../src/types';

describe('assembleContext', () => {
  test('returns empty string when no wiki or oracle results', () => {
    expect(assembleContext([], [])).toBe('');
  });

  test('includes wiki section header with path', () => {
    const wiki: WikiFetchResult[] = [
      { path: 'docs/arch.md', content: 'Architecture notes', mtimeMs: 1000 },
    ];
    const result = assembleContext(wiki, []);
    expect(result).toContain('## Wiki: docs/arch.md');
    expect(result).toContain('Architecture notes');
  });

  test('includes oracle section header with query', () => {
    const oracle: OracleFetchResult[] = [
      { query: 'BDC patterns', answer: 'The answer', citations: ['ref1.md'] },
    ];
    const result = assembleContext([], oracle);
    expect(result).toContain('## Oracle: "BDC patterns"');
    expect(result).toContain('The answer');
    expect(result).toContain('[Citations: ref1.md]');
  });

  test('includes loaded context header', () => {
    const wiki: WikiFetchResult[] = [{ path: 'doc.md', content: 'content', mtimeMs: 1000 }];
    const result = assembleContext(wiki, []);
    expect(result).toContain('# Loaded context (from persona context:)');
  });

  test('omits citations line when citations array is empty', () => {
    const oracle: OracleFetchResult[] = [{ query: 'q', answer: 'ans', citations: [] }];
    const result = assembleContext([], oracle);
    expect(result).not.toContain('[Citations:');
  });
});
