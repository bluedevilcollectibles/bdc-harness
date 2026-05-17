import { createHash } from 'crypto';
import type { AgentContext } from './types';

interface CacheEntry {
  value: string;
  expiresAt: number;
}

export class ContextCache {
  private readonly store = new Map<string, CacheEntry>();

  get(key: string): string | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: string, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

export const contextCache = new ContextCache();

export function makeCacheKey(personaName: string, context: AgentContext): string {
  const hash = createHash('sha256').update(JSON.stringify(context)).digest('hex');
  return `${personaName}:${hash}`;
}
