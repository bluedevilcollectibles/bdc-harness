import { execFileAsync } from '@archon/git';

const FORBIDDEN_PATH_PATTERNS = /deploy|secrets|credentials/i;
const OWNER_REPO = 'bluedevilcollectibles/bdc-xo';
const REF = 'main';

export class WikiFetchError extends Error {
  constructor(
    public readonly code: 'path_traversal' | 'forbidden_path' | 'gh_api_error' | 'decode_error',
    message: string
  ) {
    super(message);
    this.name = 'WikiFetchError';
  }
}

export interface WikiFetchResult {
  path: string;
  content: string;
  mtimeMs: number;
}

function validatePath(path: string): void {
  if (path.includes('../') || path.startsWith('/')) {
    throw new WikiFetchError('path_traversal', `Path traversal denied: '${path}'`);
  }
  if (FORBIDDEN_PATH_PATTERNS.test(path)) {
    throw new WikiFetchError('forbidden_path', `Forbidden path pattern in: '${path}'`);
  }
}

interface GhApiItem {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
  content?: string;
  encoding?: string;
  sha?: string;
}

async function fetchGhApi(apiPath: string, token: string): Promise<unknown> {
  const { stdout } = await execFileAsync('gh', ['api', apiPath], {
    env: { ...process.env, GITHUB_TOKEN: token },
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function fetchFile(path: string, token: string): Promise<WikiFetchResult> {
  const apiPath = `/repos/${OWNER_REPO}/contents/${path}?ref=${REF}`;
  const data = (await fetchGhApi(apiPath, token)) as GhApiItem;

  if (!data.content || data.encoding !== 'base64') {
    throw new WikiFetchError('decode_error', `Unexpected encoding for '${path}'`);
  }

  const content = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
  return { path, content, mtimeMs: Date.now() };
}

async function fetchDir(dirPath: string, token: string, depth: number): Promise<WikiFetchResult[]> {
  if (depth > 5) return [];

  const apiPath = `/repos/${OWNER_REPO}/contents/${dirPath}?ref=${REF}`;
  const data = (await fetchGhApi(apiPath, token)) as GhApiItem[];

  const results: WikiFetchResult[] = [];
  for (const item of data) {
    if (item.type === 'file' && item.path) {
      try {
        const r = await fetchFile(item.path, token);
        results.push(r);
      } catch {
        // skip unreadable files
      }
    } else if (item.type === 'dir' && item.path) {
      const sub = await fetchDir(item.path, token, depth + 1);
      results.push(...sub);
    }
  }
  return results;
}

export async function fetchWikiPath(path: string, token: string): Promise<WikiFetchResult[]> {
  validatePath(path);

  const apiPath = `/repos/${OWNER_REPO}/contents/${path}?ref=${REF}`;
  let data: unknown;
  try {
    data = await fetchGhApi(apiPath, token);
  } catch (err) {
    throw new WikiFetchError(
      'gh_api_error',
      `gh api failed for '${path}': ${(err as Error).message}`
    );
  }

  if (Array.isArray(data)) {
    return fetchDir(path, token, 0);
  }
  return [await fetchFile(path, token)];
}
