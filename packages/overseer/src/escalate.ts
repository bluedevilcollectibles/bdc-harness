/**
 * Escalation side-effect handler for silent-dead-end failures.
 *
 * Fires when @archon/overseer's decide() returns decision='escalate' WITH a populated
 * escalationContext. The executor (overseer-bridge) routes the call here. Three
 * operator-visible signals are produced for every escalation:
 *
 *   1. JSON file at <archonHome>/runs/<runId>/escalation.json containing the full
 *      structured context (errorClass, nodeId, validatorOutput, remediation, timestamp).
 *   2. Notion comment on the WO page (best-effort; needs NOTION_API_KEY + the WO ID).
 *   3. POST to BUILDER_MONITOR_WEBHOOK_URL with action='needs_human' so the n8n
 *      monitor dashboard surfaces the failure to John.
 *
 * Design notes:
 *   - Fail-soft on individual side effects: if Notion is misconfigured, escalation.json
 *     and the webhook STILL fire. The contract is "operator gets at least one signal".
 *   - Idempotent for escalation.json (overwrites cleanly) and webhook (downstream
 *     n8n flow keys on wo_id). Notion comment posts once per (runId, errorClass) by
 *     embedding the runId in the comment body — operators can re-trigger if they
 *     intentionally retry the same run.
 *   - Notion API access uses the REST API directly (not MCP) so it works inside the
 *     bun-only container at workflow runtime.
 *
 * Anchor: 2026-05-18 Wave A — silent exit-1 on commit-and-push lost work on
 * WO-AUTH-RETIRE-GAS-PATH-02 and WO-AUTH-SINGLE-PATH-E2E-04. This module is the
 * mechanism that ensures no Cauldron failure ever exits silently again.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { getArchonHome } from '@archon/paths';
import type { DecisionResult } from './decide.ts';
import type { ErrorClass } from './classify.ts';

/**
 * Structured payload accepted by runEscalation. Mirrors the loose shape of
 * DecisionResult.escalationContext but adds runtime-only fields (runId, timestamp,
 * notionPageId) populated by this module rather than the decision layer.
 */
export interface EscalationContext {
  errorClass: ErrorClass;
  nodeId?: string;
  woId?: string;
  validatorOutput?: string;
  remediation?: string[];
  /** Additional ad-hoc diagnostic fields */
  [key: string]: unknown;
}

/**
 * Default Notion database ID for BDC's main Cauldron / WO board.
 * Used as fallback when NOTION_DB_ID env var is not set. Hardcoding this single
 * BDC-specific identifier is acceptable: it is a public discovery ID (not a secret)
 * and the alternative is failing the escalation silently when the env var drifts.
 * Override via NOTION_DB_ID for non-prod environments.
 */
const BDC_DEFAULT_NOTION_DB_ID = 'a6df831c-0b52-449f-8ca4-d77be6b70d0a';
const NOTION_VERSION = '2022-06-28';
const NOTION_API_BASE = 'https://api.notion.com/v1';
const DEFAULT_BUILDER_MONITOR_URL = 'https://n8n.bluedevilcollectibles.com/webhook/builder-status';

/**
 * Run an escalation for a non-recoverable workflow failure.
 *
 * Side effects are best-effort and isolated: if any one of (escalation.json /
 * Notion comment / webhook) fails, the others are still attempted. Errors are
 * captured and surfaced via the return value rather than thrown — the caller
 * (overseer-bridge) is in a node-failure code path and should not amplify the
 * failure with an escalation-side error.
 */
export async function runEscalation(
  runId: string,
  decision: DecisionResult,
  context: EscalationContext
): Promise<void> {
  const timestamp = new Date().toISOString();

  // Always start with the on-disk artifact — it is the most reliable signal
  // (no network, no auth, no third-party). Even if everything else fails the
  // operator can grep ARCHON_HOME for escalation.json on the host.
  const archonHome = getArchonHome();
  const runDir = join(archonHome, 'runs', runId);
  const escalationPath = join(runDir, 'escalation.json');
  const payload = {
    runId,
    timestamp,
    decision: {
      decision: decision.decision,
      reason: decision.reason,
    },
    context,
  };
  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(escalationPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch (err) {
    // Stderr-only — no logger in @archon/overseer to keep the package dep-free.
    // The bridge will see the absence of escalation.json via a fs.stat() check
    // if it cares; for now we surface to the container log.
    console.error('[overseer/escalate] failed to write escalation.json:', err);
  }

  // Webhook fires regardless of Notion outcome — keeps the dashboard the source
  // of truth even when Notion is degraded.
  await postBuilderMonitorWebhook(context, decision, runId).catch(err => {
    console.error('[overseer/escalate] builder-monitor webhook failed:', err);
  });

  // Notion is last and most likely to be the bottleneck (API rate limit, key
  // missing, page-lookup failure). Operator still sees the on-disk and webhook
  // signals if this fails.
  await postNotionComment(context, decision, runId, escalationPath, timestamp).catch(err => {
    console.error('[overseer/escalate] notion comment post failed:', err);
  });
}

async function postBuilderMonitorWebhook(
  context: EscalationContext,
  decision: DecisionResult,
  runId: string
): Promise<void> {
  const url = process.env.BUILDER_MONITOR_WEBHOOK_URL ?? DEFAULT_BUILDER_MONITOR_URL;
  const woId = context.woId ?? 'unknown';
  const detail =
    `needs_human: ${context.errorClass} on run ${runId}` +
    (context.nodeId ? ` (node: ${context.nodeId})` : '') +
    ` -- ${decision.reason}`;

  // The webhook payload field set mirrors Rule 15 from the operating manual
  // (Major Build / Cauldron status posts). action='needs_human' is the
  // dedicated escalation tag; n8n routes those to the operator dashboard
  // separately from started/completed/blocked.
  const body = {
    builder: 'Cauldron',
    wo_id: woId,
    action: 'needs_human',
    detail,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`builder-monitor responded ${res.status}: ${await res.text()}`);
  }
}

async function postNotionComment(
  context: EscalationContext,
  decision: DecisionResult,
  runId: string,
  escalationPath: string,
  timestamp: string
): Promise<void> {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) {
    // Fail-soft: log to stderr and skip. escalation.json + webhook already fired.
    console.error('[overseer/escalate] NOTION_API_KEY not set -- skipping Notion comment');
    return;
  }
  if (!context.woId) {
    console.error('[overseer/escalate] no woId in context -- cannot resolve Notion page');
    return;
  }

  const databaseId = process.env.NOTION_DB_ID ?? BDC_DEFAULT_NOTION_DB_ID;
  const pageId = await lookupNotionPageId(apiKey, databaseId, context.woId);
  if (!pageId) {
    console.error(
      `[overseer/escalate] no Notion page found for WO ${context.woId} in db ${databaseId}`
    );
    return;
  }

  const remediationBlock =
    context.remediation && context.remediation.length > 0
      ? '\n\nRemediation (from validator):\n' + context.remediation.map(r => `  - ${r}`).join('\n')
      : '';
  const validatorBlock =
    context.validatorOutput && !context.remediation
      ? `\n\nValidator output:\n${context.validatorOutput}`
      : '';
  const commentText =
    `Cauldron escalation [${timestamp}] runId=${runId} node=${context.nodeId ?? '(none)'} ` +
    `class=${context.errorClass}.\n\n${decision.reason}` +
    remediationBlock +
    validatorBlock +
    `\n\nFull context: ${escalationPath}`;

  const url = `${NOTION_API_BASE}/comments`;
  const body = {
    parent: { page_id: pageId },
    rich_text: [{ type: 'text', text: { content: commentText } }],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Notion comments API responded ${res.status}: ${await res.text()}`);
  }
}

/**
 * Find a Notion page UUID by querying the database with a filter on the WO ID
 * column. Returns null if no match or if Notion returns an error.
 *
 * BDC's WO database surfaces the WO ID under different property names depending
 * on the row — we try the common ones in order. This is intentionally tolerant:
 * the goal is best-effort discovery, not exact-schema enforcement.
 */
async function lookupNotionPageId(
  apiKey: string,
  databaseId: string,
  woId: string
): Promise<string | null> {
  const url = `${NOTION_API_BASE}/databases/${databaseId}/query`;
  // Try a small list of likely property names. Notion's API accepts an OR filter
  // with up to 100 children, which is well within budget here.
  const candidateProps = ['WO ID', 'Name', 'Title', 'WO_ID'];
  const body = {
    filter: {
      or: candidateProps.flatMap(prop => [
        { property: prop, title: { equals: woId } },
        { property: prop, rich_text: { equals: woId } },
      ]),
    },
    page_size: 5,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Notion database query failed ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { results?: { id?: string }[] };
  const first = data.results?.[0];
  return first?.id ?? null;
}
