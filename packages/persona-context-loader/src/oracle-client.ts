const ORACLE_HOST = 'oracle.bluedevilcollectibles.com';
const ORACLE_URL = `https://${ORACLE_HOST}/v1/rag`;

export class OracleError extends Error {
  constructor(
    public readonly code: 'auth' | 'rate_limit' | 'server' | 'network' | 'invalid_host',
    message: string
  ) {
    super(message);
    this.name = 'OracleError';
  }
}

export interface OracleFetchResult {
  query: string;
  answer: string;
  citations: string[];
}

export async function queryOracle(query: string, apiKey: string): Promise<OracleFetchResult> {
  let response: Response;
  try {
    response = await fetch(ORACLE_URL, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
  } catch (err) {
    throw new OracleError('network', `Oracle request failed: ${(err as Error).message}`);
  }

  if (response.status === 401) {
    throw new OracleError('auth', 'Oracle authentication failed (401)');
  }
  if (response.status === 429) {
    throw new OracleError('rate_limit', 'Oracle rate limit exceeded (429)');
  }
  if (response.status >= 500) {
    throw new OracleError('server', `Oracle server error (${response.status})`);
  }
  if (!response.ok) {
    throw new OracleError('server', `Oracle unexpected status: ${response.status}`);
  }

  const body = (await response.json()) as { answer?: string; citations?: string[] };
  return {
    query,
    answer: body.answer ?? '',
    citations: Array.isArray(body.citations) ? body.citations : [],
  };
}
