import { describe, test, expect } from 'bun:test';
import { truncate } from '../src/truncator';
import type { WikiFetchResult, OracleFetchResult } from '../src/types';

const makeWiki = (path: string, content: string, mtimeMs = 1000): WikiFetchResult => ({
  path,
  content,
  mtimeMs,
});
const makeOracle = (query: string, answer: string): OracleFetchResult => ({
  query,
  answer,
  citations: [],
});

describe('truncate', () => {
  test('returns full content when under maxChars', () => {
    const wiki = [makeWiki('a.md', 'short content')];
    const oracle = [makeOracle('q', 'short answer')];
    const { block } = truncate(wiki, oracle, 100000);
    expect(block).toContain('short content');
    expect(block).toContain('short answer');
  });

  test('drops oracle results first when over maxChars', () => {
    const wiki = [makeWiki('a.md', 'wiki content')];
    const oracle = [makeOracle('q1', 'A'.repeat(1000)), makeOracle('q2', 'B'.repeat(1000))];
    const result = truncate(wiki, oracle, 200);
    expect(result.oracleChars).toBeLessThan(2000);
    expect(result.block).toContain('wiki content');
  });

  test('drops oldest wiki (lowest mtimeMs) when oracle is gone and still over', () => {
    const wiki = [
      makeWiki('old.md', 'O'.repeat(500), 1000),
      makeWiki('new.md', 'N'.repeat(500), 9000),
    ];
    const result = truncate(wiki, [], 600);
    // old.md should be dropped first (lowest mtime)
    expect(result.block).toContain('new.md');
    expect(result.wikiChars).toBeLessThan(1000);
  });

  test('hard cap at maxChars ensures result never exceeds limit', () => {
    const wiki = [makeWiki('big.md', 'X'.repeat(10000))];
    const { block } = truncate(wiki, [], 100);
    expect(block.length).toBeLessThanOrEqual(100);
  });

  test('wikiChars and oracleChars reflect remaining content', () => {
    const wiki = [makeWiki('a.md', 'hello world')];
    const oracle = [makeOracle('q', 'answer here')];
    const { wikiChars, oracleChars } = truncate(wiki, oracle, 100000);
    expect(wikiChars).toBe('hello world'.length);
    expect(oracleChars).toBe('answer here'.length);
  });
});
