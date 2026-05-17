import { createLogger } from '@archon/paths';
import { fetchWikiPath } from './wiki-fetcher';
import { queryOracle, OracleError } from './oracle-client';
import { truncate } from './truncator';
import { contextCache, makeCacheKey } from './cache';
import type { WikiFetchResult, OracleFetchResult, AgentContext } from './types';

export type { AgentContext, WikiFetchResult, OracleFetchResult, ContextLoadResult } from './types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('persona-context-loader');
  return cachedLog;
}

const ORACLE_API_KEY = process.env.ORACLE_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

export interface PersonaContextInput {
  name: string;
  context?: AgentContext;
}

export async function loadContext(agent: PersonaContextInput): Promise<string> {
  const context = agent.context;
  if (!context) return '';

  const cacheKey = makeCacheKey(agent.name, context);
  const cached = contextCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const wikiResults: WikiFetchResult[] = [];
  const oracleResults: OracleFetchResult[] = [];

  if (context.wiki && context.wiki.length > 0) {
    if (!GITHUB_TOKEN) {
      getLog().warn({ name: agent.name }, 'context_loader.github_token_missing');
    } else {
      const wikiPromises = context.wiki.map(path =>
        fetchWikiPath(path, GITHUB_TOKEN).catch(err => {
          getLog().warn(
            { name: agent.name, path, err: (err as Error).message },
            'context_loader.wiki_fetch_failed'
          );
          return [] as WikiFetchResult[];
        })
      );
      const settled = await Promise.allSettled(wikiPromises);
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          wikiResults.push(...result.value);
        }
      }
    }
  }

  if (context.oracle && context.oracle.length > 0) {
    if (!ORACLE_API_KEY) {
      getLog().warn({ name: agent.name }, 'context_loader.oracle_api_key_missing');
    } else {
      const oraclePromises = context.oracle.map(query =>
        queryOracle(query, ORACLE_API_KEY).catch(err => {
          if (err instanceof OracleError) {
            getLog().warn(
              { name: agent.name, query, code: err.code, err: err.message },
              'context_loader.oracle_unreachable'
            );
          } else {
            getLog().warn(
              { name: agent.name, query, err: (err as Error).message },
              'context_loader.oracle_unreachable'
            );
          }
          return null;
        })
      );
      const settled = await Promise.allSettled(oraclePromises);
      for (const result of settled) {
        if (result.status === 'fulfilled' && result.value !== null) {
          oracleResults.push(result.value);
        }
      }
    }
  }

  const maxChars = context.max_chars ?? 50000;
  const totalRaw =
    wikiResults.reduce((s, w) => s + w.content.length, 0) +
    oracleResults.reduce((s, o) => s + o.answer.length, 0);
  const { block, wikiChars, oracleChars } = truncate(wikiResults, oracleResults, maxChars);

  if (block.length < totalRaw) {
    getLog().warn(
      { name: agent.name, rawChars: totalRaw, truncatedTo: block.length, maxChars },
      'context_loader.truncated'
    );
  }

  getLog().info(
    { name: agent.name, wikiChars, oracleChars, totalChars: block.length },
    'agent.context_loaded'
  );

  const ttlMs = (context.cache_seconds ?? 3600) * 1000;
  contextCache.set(cacheKey, block, ttlMs);

  return block;
}
