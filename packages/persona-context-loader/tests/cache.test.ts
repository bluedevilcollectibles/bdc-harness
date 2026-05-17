import { describe, test, expect } from 'bun:test';
import { ContextCache, makeCacheKey } from '../src/cache';

describe('makeCacheKey', () => {
  test('same persona and context produces same key', () => {
    const ctx = { wiki: ['docs/a.md'], cache_seconds: 3600 };
    expect(makeCacheKey('architect', ctx)).toBe(makeCacheKey('architect', ctx));
  });

  test('different persona names produce different keys', () => {
    const ctx = { wiki: ['docs/a.md'] };
    expect(makeCacheKey('architect', ctx)).not.toBe(makeCacheKey('reviewer', ctx));
  });

  test('different contexts produce different keys', () => {
    expect(makeCacheKey('arch', { wiki: ['a.md'] })).not.toBe(
      makeCacheKey('arch', { wiki: ['b.md'] })
    );
  });
});

describe('ContextCache', () => {
  test('get returns undefined for missing key', () => {
    const cache = new ContextCache();
    expect(cache.get('missing')).toBeUndefined();
  });

  test('get returns value before expiry', () => {
    const cache = new ContextCache();
    cache.set('key', 'value', 60000);
    expect(cache.get('key')).toBe('value');
  });

  test('get returns undefined after expiry', async () => {
    const cache = new ContextCache();
    cache.set('key', 'value', 1);
    await new Promise(r => setTimeout(r, 10));
    expect(cache.get('key')).toBeUndefined();
  });
});
