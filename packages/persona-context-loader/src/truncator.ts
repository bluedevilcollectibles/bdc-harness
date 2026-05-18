import type { WikiFetchResult, OracleFetchResult } from './types';
import { assembleContext } from './assembler';

export interface TruncateResult {
  block: string;
  wikiChars: number;
  oracleChars: number;
}

export function truncate(
  wiki: WikiFetchResult[],
  oracle: OracleFetchResult[],
  maxChars: number
): TruncateResult {
  let currentWiki = [...wiki];
  let currentOracle = [...oracle];

  let block = assembleContext(currentWiki, currentOracle);

  if (block.length <= maxChars) {
    return {
      block,
      wikiChars: currentWiki.reduce((s, w) => s + w.content.length, 0),
      oracleChars: currentOracle.reduce((s, o) => s + o.answer.length, 0),
    };
  }

  // Drop oracle results first (last query first)
  while (block.length > maxChars && currentOracle.length > 0) {
    currentOracle = currentOracle.slice(0, -1);
    block = assembleContext(currentWiki, currentOracle);
  }

  // Then drop wiki entries (oldest mtime first = lowest mtimeMs = lowest priority)
  if (block.length > maxChars) {
    const sortedByMtime = [...currentWiki].sort((a, b) => a.mtimeMs - b.mtimeMs);
    const toRemove = new Set<string>();

    for (const w of sortedByMtime) {
      if (block.length <= maxChars) break;
      toRemove.add(w.path);
      currentWiki = currentWiki.filter(x => !toRemove.has(x.path));
      block = assembleContext(currentWiki, currentOracle);
    }
  }

  // Hard cap: slice at maxChars if still over
  if (block.length > maxChars) {
    block = block.slice(0, maxChars);
  }

  return {
    block,
    wikiChars: currentWiki.reduce((s, w) => s + w.content.length, 0),
    oracleChars: currentOracle.reduce((s, o) => s + o.answer.length, 0),
  };
}
