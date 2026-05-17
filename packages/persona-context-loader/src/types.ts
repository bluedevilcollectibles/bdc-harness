export interface AgentContext {
  wiki?: string[];
  oracle?: string[];
  ad_hoc?: 'allowed' | 'restricted' | 'denied';
  cache_seconds?: number;
  max_chars?: number;
}

export interface WikiFetchResult {
  path: string;
  content: string;
  mtimeMs: number;
}

export interface OracleFetchResult {
  query: string;
  answer: string;
  citations: string[];
}

export interface ContextLoadResult {
  contextBlock: string;
  wikiChars: number;
  oracleChars: number;
}
