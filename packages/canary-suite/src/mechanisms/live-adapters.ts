import {
  acknowledgeMessage,
  createAuthenticatedMessage,
  getDatabase,
  getHealthSample,
  getMessage,
  upsertHealthSample,
} from '@archon/core/db';
import { queryOracle } from '@archon/persona-context-loader/oracle-client';
import { fetchWikiPath } from '@archon/persona-context-loader/wiki-fetcher';
import type { DispatchRoundTrip } from './probes/dispatch-transport';
import type { InboxRoundTrip } from './probes/operator-inbox';
import type { ReviewCoverage } from './probes/review-gate';
import type { XoLeaseSignal } from './probes/xo-lease';
import { reviewCorrelationId } from '@archon/overseer/pr-review-ingest';

export function reviewCoverageAdapter(env: Readonly<Record<string, string | undefined>>) {
  return async (): Promise<ReviewCoverage[]> => {
    const repo = env.REVIEW_CANARY_REPO;
    const token = env.GITHUB_TOKEN;
    if (!repo || !token) throw new Error('review_gate_configuration_missing');
    const response = await fetch(
      `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      }
    );
    if (!response.ok) throw new Error(`github_open_prs_http_${response.status}`);
    const prs = (await response.json()) as Array<{ number: number }>;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const ingests = await getDatabase().query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM agent_dispatch_messages
       WHERE task_type = 'run_review' AND created_at >= $1 AND correlation_id LIKE $2`,
      [
        since,
        `${reviewCorrelationId({ owner: repo.split('/')[0] ?? '', repo: repo.split('/')[1] ?? '', prNumber: 0, headSha: '' }).split('#')[0]}#%`,
      ]
    );
    return [
      { repo, openPrCount: prs.length, recentIngestCount: Number(ingests.rows[0]?.count ?? 0) },
    ];
  };
}

export async function xoLeaseSignal(
  env: Readonly<Record<string, string | undefined>>
): Promise<XoLeaseSignal | null> {
  if (!env.XO_LEASE_STATUS_URL) return null;
  const response = await fetch(
    env.XO_LEASE_STATUS_URL,
    env.ARCHON_OPERATOR_TOKEN
      ? { headers: { authorization: `Bearer ${env.ARCHON_OPERATOR_TOKEN}` } }
      : undefined
  );
  if (!response.ok) throw new Error(`xo_lease_status_http_${response.status}`);
  const body = (await response.json()) as Omit<XoLeaseSignal, 'windowMs'> & { windowMs?: number };
  return { ...body, windowMs: body.windowMs ?? (Number(env.XO_LEASE_WINDOW_MS) || 21_600_000) };
}

export function dispatchTransports(
  env: Readonly<Record<string, string | undefined>>
): DispatchRoundTrip[] {
  const raw = env.DISPATCH_CANARY_ENDPOINTS;
  if (!raw) return [];
  const endpoints = JSON.parse(raw) as Record<string, string>;
  return Object.entries(endpoints).map(([provider, url]) => ({
    provider,
    async roundTrip() {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(env.ARCHON_OPERATOR_TOKEN
            ? { authorization: `Bearer ${env.ARCHON_OPERATOR_TOKEN}` }
            : {}),
        },
        body: JSON.stringify({ message: 'Reply with CANARY_OK.' }),
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
      return response.text();
    },
  }));
}

export function ledgerAdapter() {
  return {
    write: async (id: string) => {
      await upsertHealthSample({
        provider: id,
        state: 'healthy',
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        evidence: 'cross-mechanism-canary',
      });
    },
    read: (id: string) => getHealthSample(id),
  };
}

export function operatorInboxAdapter(): InboxRoundTrip {
  let messageId: string | undefined;
  return {
    async post(id) {
      const message = await createAuthenticatedMessage(
        { kind: 'system', sender: 'dispatch' },
        {
          correlation_id: id,
          idempotency_key: id,
          task_type: 'agent_message',
          recipient: 'operator',
          body: JSON.stringify({ kind: 'canary', id }),
        }
      );
      messageId = message.id;
    },
    async retrieve() {
      return Boolean(messageId && (await getMessage(messageId)));
    },
    async acknowledge() {
      if (!messageId) return false;
      return (await acknowledgeMessage({ id: messageId, principal_id: 'operator' })).ok;
    },
  };
}

export function knowledgeSignals(env: Readonly<Record<string, string | undefined>>) {
  return {
    oracle: async (query: string) => {
      if (!env.ORACLE_API_KEY) throw new Error('oracle_api_key_missing');
      return queryOracle(query, env.ORACLE_API_KEY);
    },
    wikiIndex: async () => {
      if (!env.GITHUB_TOKEN) throw new Error('github_token_missing');
      const rows = await fetchWikiPath(env.CANARY_WIKI_PATH ?? 'docs', env.GITHUB_TOKEN);
      return rows.some(row => row.content.includes('Cauldron Canary Suite'));
    },
  };
}

export async function deploySignals(env: Readonly<Record<string, string | undefined>>) {
  const repo = env.DEPLOY_CANARY_REPO;
  const revisionUrl = env.DEPLOY_REVISION_URL;
  if (!repo || !revisionUrl || !env.GITHUB_TOKEN) return [];
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
  };
  const [headResponse, deployedResponse] = await Promise.all([
    fetch(`https://api.github.com/repos/${repo}/commits/main`, { headers }),
    fetch(
      revisionUrl,
      env.ARCHON_OPERATOR_TOKEN
        ? { headers: { authorization: `Bearer ${env.ARCHON_OPERATOR_TOKEN}` } }
        : undefined
    ),
  ]);
  if (!headResponse.ok) throw new Error(`github_head_http_${headResponse.status}`);
  if (!deployedResponse.ok) throw new Error(`deploy_revision_http_${deployedResponse.status}`);
  const head = (await headResponse.json()) as { sha: string };
  const deployed = (await deployedResponse.json()) as { revision?: string };
  return [{ surface: repo, expectedHead: head.sha, deployedRevision: deployed.revision ?? null }];
}
