import { createHash } from 'crypto';
import type { RunAuthorityPolicy } from '@archon/workflows/schemas/workflow';
import type { FrozenSpecSource } from '@archon/workflows/reliability/run-authority';

export interface WorkOrderSourceDependencies {
  readonly fetcher?: typeof fetch;
  readonly githubToken?: string;
}

/** A constraint on policy-resolved authority, never an alternate authority source. */
export interface ExpectedSpecIdentity {
  readonly specSource: string;
  readonly specRevision: string;
  readonly specHash: string;
}

function readExpectedSpecIdentity(userMessage: string): ExpectedSpecIdentity | undefined {
  const header = userMessage.split(/\r?\n/, 1)[0];
  if (!header.includes('--expected-spec')) return undefined;
  const match =
    /^(?:\/workflow run [A-Za-z0-9_-]+ )?WO_ID=WO-[A-Z0-9-]+ --project [A-Za-z0-9_.-]+ --expected-spec=([A-Za-z0-9_-]+)$/.exec(
      header
    );
  if (!match) throw new Error('authority_conflict: malformed expected spec header');
  try {
    const value: unknown = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) throw new Error();
    const identity = value as Record<string, unknown>;
    if (
      Object.keys(identity).length !== 3 ||
      typeof identity.specSource !== 'string' ||
      !identity.specSource ||
      typeof identity.specRevision !== 'string' ||
      !identity.specRevision ||
      typeof identity.specHash !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(identity.specHash)
    )
      throw new Error();
    return identity as unknown as ExpectedSpecIdentity;
  } catch {
    throw new Error('authority_conflict: malformed expected spec identity');
  }
}

function githubHeaders(token: string | undefined): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) return {};
  const value: unknown = await response.json();
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function readWoId(value: string): string | undefined {
  return /\bWO-[A-Z0-9-]+\b/.exec(value)?.[0];
}

function readIssueNumber(value: string): number | undefined {
  const raw = /\bissue=(\d+)\b/i.exec(value)?.[1];
  if (!raw) return undefined;
  const issueNumber = Number.parseInt(raw, 10);
  return Number.isSafeInteger(issueNumber) && issueNumber > 0 ? issueNumber : undefined;
}

async function freezeIssueSource(input: {
  repository: string;
  issueNumber: number;
  messageWoId?: string;
  fetcher: typeof fetch;
  headers: Record<string, string>;
}): Promise<FrozenSpecSource> {
  const response = await input.fetcher(
    `https://api.github.com/repos/${input.repository}/issues/${String(input.issueNumber)}`,
    { headers: input.headers }
  );
  const issue = await readJson(response);
  const title = typeof issue.title === 'string' ? issue.title : '';
  const body = typeof issue.body === 'string' ? issue.body : '';
  const updatedAt = typeof issue.updated_at === 'string' ? issue.updated_at : '';
  const woId = input.messageWoId ?? readWoId(`${title}\n${body}`);
  if (!woId) throw new Error('scope_authority_missing: woId');
  if (!body.trim() || !updatedAt) throw new Error('scope_authority_missing: issue spec');
  return {
    woId,
    specSource: `github:${input.repository}:issues/${String(input.issueNumber)}`,
    specRevision: `issue:${String(input.issueNumber)}:${updatedAt}`,
    specBytes: Buffer.from(body, 'utf8'),
  };
}

export async function freezeWorkOrderSource(
  policy: RunAuthorityPolicy,
  userMessage: string,
  dependencies: WorkOrderSourceDependencies = {}
): Promise<FrozenSpecSource> {
  const expected = readExpectedSpecIdentity(userMessage);
  const source = await resolveWorkOrderSource(policy, userMessage, dependencies);
  if (
    expected &&
    (source.specSource !== expected.specSource ||
      source.specRevision !== expected.specRevision ||
      `sha256:${createHash('sha256').update(source.specBytes).digest('hex')}` !== expected.specHash)
  )
    throw new Error('authority_conflict: canonical spec changed since eligibility');
  return source;
}

async function resolveWorkOrderSource(
  policy: RunAuthorityPolicy,
  userMessage: string,
  dependencies: WorkOrderSourceDependencies
): Promise<FrozenSpecSource> {
  const repository = policy.spec_repository;
  const woId = readWoId(userMessage);
  const issueNumber = readIssueNumber(userMessage);
  if (!woId) {
    if (!policy.allow_issue_fallback || !issueNumber) {
      throw new Error(
        policy.allow_issue_fallback
          ? 'scope_authority_missing: woId or issue'
          : 'scope_authority_missing: woId'
      );
    }
  }

  const fetcher = dependencies.fetcher ?? fetch;
  const token = dependencies.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!dependencies.fetcher && !token) {
    throw new Error('scope_authority_missing: GitHub authentication');
  }
  const headers = githubHeaders(token);
  if (!woId && issueNumber) {
    return freezeIssueSource({ repository, issueNumber, fetcher, headers });
  }
  if (!woId) throw new Error('scope_authority_missing: woId');

  const revisionResponse = await fetcher(
    `https://api.github.com/repos/${repository}/git/ref/heads/${encodeURIComponent(policy.spec_revision)}`,
    { headers }
  );
  const revisionJson = await readJson(revisionResponse);
  const object = revisionJson.object;
  const specRevision =
    typeof object === 'object' &&
    object !== null &&
    typeof (object as { sha?: unknown }).sha === 'string'
      ? (object as { sha: string }).sha
      : '';

  if (specRevision) {
    for (const template of policy.spec_paths) {
      const path = template.replaceAll('{WO_ID}', woId);
      const response = await fetcher(
        `https://api.github.com/repos/${repository}/contents/${encodePath(path)}?ref=${encodeURIComponent(specRevision)}`,
        { headers }
      );
      const json = await readJson(response);
      if (json.type !== 'file' || typeof json.content !== 'string') continue;
      const specBytes = Buffer.from(json.content.replace(/\s/g, ''), 'base64');
      if (specBytes.byteLength === 0) continue;
      return {
        woId,
        specSource: `github:${repository}:${path}`,
        specRevision,
        specBytes,
      };
    }
  }

  if (policy.allow_issue_fallback && issueNumber) {
    return freezeIssueSource({ repository, issueNumber, messageWoId: woId, fetcher, headers });
  }
  if (!specRevision) throw new Error('scope_authority_missing: specRevision');
  throw new Error('scope_authority_missing: canonical spec');
}
