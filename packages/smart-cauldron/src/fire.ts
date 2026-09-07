/**
 * fire.ts -- Fires a WO through Archon's atomic conversation dispatch API.
 *
 * The supported path is one POST /api/conversations containing both the
 * resolved codebaseId and the /workflow run command. The response must prove
 * dispatched:true. The resulting run is discovered by the returned parent
 * conversation database id; no conversation identity is fabricated locally.
 *
 * Secret boundary: apiBaseUrl and token come from the caller or environment.
 */

import type { FireResult } from './types.js';
import type { ExpectedSpecIdentity } from '@archon/core/workflows/work-order-source';

interface FireTierOptions {
  workflowName: string;
  woId: string;
  /** Registered codebase shortname, for example bdc-harness. */
  project: string;
  /** Workflow arguments, including WO_ID and the explicit project flag. */
  message: string;
  /** Archon API base URL, e.g. http://localhost:3090. */
  apiBaseUrl: string;
  /** Operator token for Archon API auth. Defaults to ARCHON_OPERATOR_TOKEN env. */
  token?: string;
  /** How long to wait for run discovery before giving up (ms). Default: 30000. */
  discoverTimeoutMs?: number;
  /** Poll interval for discovery (ms). Default: 3000. */
  discoverIntervalMs?: number;
}

interface CodebaseSummary {
  id: string;
  name: string;
}

interface AtomicConversationResponse {
  conversationId?: string;
  id?: string;
  dispatched?: boolean;
  error?: string;
}

interface WorkflowRunSummary {
  id?: string;
  workflow_name?: string;
  parent_conversation_id?: string | null;
  codebase_id?: string | null;
}

function authHeaders(token: string): Record<string, string> {
  return { 'x-archon-operator-token': token };
}

async function responseSummary(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return '';
  }
}

function matchesProject(codebaseName: string, project: string): boolean {
  const normalizedName = codebaseName.toLowerCase();
  const normalizedProject = project.toLowerCase();
  const shortName = normalizedName.split('/').pop() ?? normalizedName;
  return normalizedName === normalizedProject || shortName === normalizedProject;
}

async function resolveCodebaseId(
  project: string,
  apiBaseUrl: string,
  token: string
): Promise<{ codebaseId: string | null; error: string | null }> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/api/codebases`, {
      headers: authHeaders(token),
    });
  } catch (error) {
    return {
      codebaseId: null,
      error: `[smart-cauldron/fire] network error resolving project ${project}: ${(error as Error).message}`,
    };
  }

  if (!response.ok) {
    return {
      codebaseId: null,
      error: `HTTP ${response.status} resolving project ${project}: ${await responseSummary(response)}`,
    };
  }

  let codebases: CodebaseSummary[];
  try {
    codebases = (await response.json()) as CodebaseSummary[];
  } catch (error) {
    return {
      codebaseId: null,
      error: `invalid codebase response while resolving project ${project}: ${(error as Error).message}`,
    };
  }

  const matches = Array.isArray(codebases)
    ? codebases.filter(
        codebase =>
          typeof codebase.id === 'string' &&
          typeof codebase.name === 'string' &&
          matchesProject(codebase.name, project)
      )
    : [];

  if (matches.length !== 1) {
    return {
      codebaseId: null,
      error: `project ${project} resolved to ${String(matches.length)} codebases; exactly one is required`,
    };
  }

  return { codebaseId: matches[0]?.id ?? null, error: null };
}

/** Fire a WO and return only after its workflow run row is discoverable. */
export async function fireTier(opts: FireTierOptions): Promise<FireResult> {
  const {
    workflowName,
    woId,
    project,
    message,
    apiBaseUrl,
    token: tokenOverride,
    discoverTimeoutMs = 30_000,
    discoverIntervalMs = 3_000,
  } = opts;

  const token = tokenOverride ?? process.env.ARCHON_OPERATOR_TOKEN ?? '';
  const binding = await resolveCodebaseId(project, apiBaseUrl, token);
  if (binding.codebaseId === null) {
    return { ok: false, runId: null, conversationId: null, infraError: binding.error };
  }

  const requiredPrefix = `WO_ID=${woId} --project ${project}`;
  if (!message.startsWith(requiredPrefix)) {
    return {
      ok: false,
      runId: null,
      conversationId: null,
      infraError: `fire message must start with ${requiredPrefix}`,
    };
  }

  let fireResponse: Response;
  try {
    fireResponse = await fetch(`${apiBaseUrl}/api/conversations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(token),
      },
      body: JSON.stringify({
        codebaseId: binding.codebaseId,
        message: `/workflow run ${workflowName} ${message}`,
      }),
    });
  } catch (error) {
    return {
      ok: false,
      runId: null,
      conversationId: null,
      infraError: `[smart-cauldron/fire] network error on POST /api/conversations: ${(error as Error).message}`,
    };
  }

  if (!fireResponse.ok) {
    return {
      ok: false,
      runId: null,
      conversationId: null,
      infraError: `HTTP ${fireResponse.status}: ${await responseSummary(fireResponse)}`,
    };
  }

  let fireBody: AtomicConversationResponse;
  try {
    fireBody = (await fireResponse.json()) as AtomicConversationResponse;
  } catch (error) {
    return {
      ok: false,
      runId: null,
      conversationId: null,
      infraError: `invalid atomic conversation response: ${(error as Error).message}`,
    };
  }

  const conversationId =
    typeof fireBody.conversationId === 'string' ? fireBody.conversationId : null;
  const parentConversationId = typeof fireBody.id === 'string' ? fireBody.id : null;
  if (fireBody.dispatched !== true || conversationId === null || parentConversationId === null) {
    const detail = typeof fireBody.error === 'string' ? `: ${fireBody.error}` : '';
    return {
      ok: false,
      runId: null,
      conversationId,
      infraError: `atomic conversation did not prove dispatched:true${detail}`,
    };
  }

  const runId = await discoverRunId({
    parentConversationId,
    workflowName,
    codebaseId: binding.codebaseId,
    apiBaseUrl,
    timeoutMs: discoverTimeoutMs,
    intervalMs: discoverIntervalMs,
    token,
  });
  if (runId === null) {
    return {
      ok: false,
      runId: null,
      conversationId,
      infraError: `run discovery timeout after ${discoverTimeoutMs}ms for parent conversation ${parentConversationId}`,
    };
  }

  return { ok: true, runId, conversationId, infraError: null };
}

async function discoverRunId(opts: {
  parentConversationId: string;
  workflowName: string;
  codebaseId: string;
  apiBaseUrl: string;
  timeoutMs: number;
  intervalMs: number;
  token: string;
}): Promise<string | null> {
  const deadline = Date.now() + opts.timeoutMs;
  const query = new URLSearchParams({ codebaseId: opts.codebaseId, limit: '50' });

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${opts.apiBaseUrl}/api/workflows/runs?${query.toString()}`, {
        headers: authHeaders(opts.token),
      });
      if (response.ok) {
        const body = (await response.json()) as { runs?: WorkflowRunSummary[] };
        const run = body.runs?.find(
          candidate =>
            candidate.parent_conversation_id === opts.parentConversationId &&
            candidate.workflow_name === opts.workflowName &&
            candidate.codebase_id === opts.codebaseId &&
            typeof candidate.id === 'string'
        );
        if (run?.id) return run.id;
      }
    } catch {
      // A transient discovery read does not invalidate the proven dispatch.
    }

    await new Promise<void>(resolve => setTimeout(resolve, opts.intervalMs));
  }

  return null;
}

/** Build the workflow arguments with an explicit, immutable project binding. */
export function buildFireMessage(
  woId: string,
  project: string,
  priorAttemptContext?: string,
  expectedSpec?: ExpectedSpecIdentity
): string {
  const binding = expectedSpec
    ? ` --expected-spec=${Buffer.from(JSON.stringify(expectedSpec)).toString('base64url')}`
    : '';
  const base = `WO_ID=${woId} --project ${project}${binding}`;
  if (!priorAttemptContext) return base;
  return `${base}\n\n## Prior attempt context\n${priorAttemptContext}`;
}
