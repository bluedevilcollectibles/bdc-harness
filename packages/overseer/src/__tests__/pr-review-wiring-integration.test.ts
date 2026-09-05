/**
 * WO-HARNESS-OVERSEER-REVIEW-ROUTE-01 -- integration test against a REAL
 * database, not a fake IngestDeps.
 *
 * Review finding (Codex, third-pass review, 2026-08-19): the unit tests for
 * pr-review-wiring.ts never exercised createRealIngestDeps against the real
 * dispatch DAL. That gap hid a real defect -- enqueueReviewWork sends to
 * recipient overseer-reviewer, but Dispatch recipient validation
 * assessDispatchRecipientWithQuery REJECTS any recipient absent from
 * dispatch_principals with reason missing_principal. The recipient was not
 * seeded anywhere, so every real enqueue attempt would have failed on first
 * use. Fixed by migration 043 (+ the SQLite adapter's seed mirror, which is
 * hand-maintained and NOT derived from the migration files). M-129 Phase 1.5
 * additionally binds the internal writer to the code-fixed system:overseer
 * principal instead of accepting an unguarded sender string.
 *
 * This test proves the fix by running createRealIngestDeps against a real
 * SqliteAdapter -- the same adapter class production code uses -- with NO
 * mocking of the dispatch DAL. If the principals are ever un-seeded again,
 * this test fails with the exact real-world symptom instead of passing
 * vacuously against a fake.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, mock } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import type { RealGitHubOctokitLike } from '../adapters/github-real-deps.ts';

let db: import('@archon/core/db/adapters/sqlite').SqliteAdapter;
let currentDbPath = '';

// Bug found + fixed 2026-08-25 (same disease class as the CI-stabilization
// WO this test's sibling PR fixed): mock.module() patches the PROCESS-GLOBAL
// module registry, so replacing '@archon/core/db/connection' with an object
// carrying ONLY getDatabase silently dropped every other export of that
// module (getDialect, pool, etc.) for every LATER-loaded test file that
// imports from it -- crashing them at import time with "Export named
// 'getDialect' not found". Spreading the real module and restoring in
// afterAll keeps the blast radius inside this file.
import * as realConnection from '@archon/core/db/connection';

mock.module('@archon/core/db/connection', () => ({
  ...realConnection,
  getDatabase: () => db,
}));

afterAll(() => {
  mock.restore();
});

const { SqliteAdapter } = await import('@archon/core/db/adapters/sqlite');
const { createRealIngestDeps, createRealSubmitDeps, REVIEW_RECIPIENT, REVIEW_SENDER } =
  await import('../pr-review-wiring.ts');
const { ingestPullRequestEvent } = await import('../pr-review-ingest.ts');
const { createHmac } = await import('crypto');

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

function sign(payload: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

function submitOctokit(): RealGitHubOctokitLike {
  return {
    pulls: {
      get: async () => ({ data: { head: { sha: 'a'.repeat(40) } } }),
      createReview: async () => ({ data: { id: 1, state: 'APPROVED' } }),
    },
    checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
  } as unknown as RealGitHubOctokitLike;
}

describe('pr-review-wiring against a real SqliteAdapter', () => {
  beforeEach(() => {
    currentDbPath = join(
      import.meta.dir,
      `.test-pr-review-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('overseer-reviewer and the code-fixed Overseer sender are seeded principals', async () => {
    const rows = await db.query<{ principal_id: string; active: number }>(
      'SELECT principal_id, active FROM dispatch_principals WHERE principal_id IN ($1, $2)',
      [REVIEW_RECIPIENT, REVIEW_SENDER]
    );
    const found = new Set(rows.rows.map(row => row.principal_id));
    expect(found.has(REVIEW_RECIPIENT)).toBe(true);
    expect(found.has(REVIEW_SENDER)).toBe(true);
    expect(rows.rows.every(row => row.active === 1)).toBe(true);
  });

  test('a real pull_request event enqueues successfully end-to-end (no missing_principal)', async () => {
    const config = {
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    };
    const deps = createRealIngestDeps(config);

    const headSha = 'c'.repeat(40);
    const payload = JSON.stringify({
      action: 'opened',
      number: 42,
      pull_request: {
        number: 42,
        draft: false,
        head: { sha: headSha, ref: 'feature-branch' },
        base: { ref: 'dev', sha: 'd'.repeat(40) },
        user: { login: 'bluedevilcollectibles' },
      },
      repository: { name: 'bdc-harness', owner: { login: 'thinmansoftware' } },
    });

    const result = await ingestPullRequestEvent(
      {
        rawBody: payload,
        signature: sign(payload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-1',
      },
      deps
    );

    expect(result.disposition).toBe('queued');
    expect(result.messageId).toBeDefined();

    const row = await db.query<{
      recipient: string;
      sender: string;
      sender_principal_id: string | null;
      task_type: string;
    }>(
      `SELECT recipient, sender, sender_principal_id, task_type
       FROM agent_dispatch_messages WHERE id = $1`,
      [result.messageId]
    );
    expect(row.rows[0]?.recipient).toBe(REVIEW_RECIPIENT);
    expect(row.rows[0]?.sender).toBe(REVIEW_SENDER);
    expect(row.rows[0]?.sender_principal_id).toBe('system:overseer');
    expect(row.rows[0]?.task_type).toBe('run_review');
  });

  test('a real review submission receipt binds the code-fixed Overseer system principal', async () => {
    const deps = createRealSubmitDeps('thinman-overseer[bot]', {
      octokit: submitOctokit(),
    });

    await deps.recordReceipt({
      correlationId: 'submit-correlation-1',
      messageId: 'submit-message-1',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 669,
      headSha: 'b'.repeat(40),
      disposition: 'approved',
      event: 'APPROVE',
    });

    const row = await db.query<{
      recipient: string;
      sender: string;
      sender_principal_id: string | null;
      task_type: string;
    }>(
      `SELECT recipient, sender, sender_principal_id, task_type
       FROM agent_dispatch_messages
       WHERE idempotency_key = $1`,
      ['pr-review-submit-receipt:submit-message-1:approved']
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.recipient).toBe('operator');
    expect(row.rows[0]?.sender).toBe(REVIEW_SENDER);
    expect(row.rows[0]?.sender_principal_id).toBe('system:overseer');
    expect(row.rows[0]?.task_type).toBe('run_report');
  });

  test('a second delivery of the same head is a genuine no-op duplicate (DB-enforced)', async () => {
    const config = {
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    };
    const deps = createRealIngestDeps(config);
    const headSha = 'e'.repeat(40);
    const payload = JSON.stringify({
      action: 'opened',
      number: 99,
      pull_request: {
        number: 99,
        draft: false,
        head: { sha: headSha, ref: 'feature-branch' },
        base: { ref: 'dev', sha: 'f'.repeat(40) },
        user: { login: 'bluedevilcollectibles' },
      },
      repository: { name: 'bdc-harness', owner: { login: 'thinmansoftware' } },
    });
    const req = {
      rawBody: payload,
      signature: sign(payload, config.webhookSecret),
      eventType: 'pull_request',
      deliveryId: 'integration-delivery-2',
    };

    const first = await ingestPullRequestEvent(req, deps);
    expect(first.disposition).toBe('queued');

    const second = await ingestPullRequestEvent(
      { ...req, deliveryId: 'integration-delivery-2-retry' },
      deps
    );
    expect(second.disposition).toBe('duplicate_delivery');
    expect(second.messageId).toBe(first.messageId);

    const count = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM agent_dispatch_messages WHERE recipient = $1',
      [REVIEW_RECIPIENT]
    );
    expect(Number(count.rows[0]?.n ?? 0)).toBe(1);
  });

  test('a new head enqueues after the prior review reaches a terminal state', async () => {
    const config = {
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    };
    const deps = createRealIngestDeps(config);

    const payloadFor = (action: 'opened' | 'synchronize', headSha: string): string =>
      JSON.stringify({
        action,
        number: 148,
        pull_request: {
          number: 148,
          draft: false,
          head: { sha: headSha, ref: 'feature-branch' },
          base: { ref: 'dev', sha: 'f'.repeat(40) },
          user: { login: 'bluedevilcollectibles' },
        },
        repository: { name: 'bdc-harness', owner: { login: 'thinmansoftware' } },
      });

    const firstPayload = payloadFor('opened', '1'.repeat(40));
    const first = await ingestPullRequestEvent(
      {
        rawBody: firstPayload,
        signature: sign(firstPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-terminal-head-1',
      },
      deps
    );
    expect(first.disposition).toBe('queued');

    await db.query(
      `UPDATE agent_dispatch_messages
       SET status = 'done', completed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [first.messageId]
    );
    await createRealSubmitDeps('thinman-overseer[bot]', { octokit: submitOctokit() }).recordReceipt(
      {
        correlationId: first.correlationId ?? '',
        messageId: first.messageId ?? '',
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        prNumber: 148,
        headSha: '1'.repeat(40),
        disposition: 'changes_requested',
        event: 'REQUEST_CHANGES',
      }
    );

    const secondHeadSha = '2'.repeat(40);
    const secondPayload = payloadFor('synchronize', secondHeadSha);
    const second = await ingestPullRequestEvent(
      {
        rawBody: secondPayload,
        signature: sign(secondPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-terminal-head-2',
      },
      deps
    );

    expect(second.disposition).toBe('queued');
    expect(second.messageId).not.toBe(first.messageId);

    const rows = await db.query<{ repeat_reason: string | null; body: string }>(
      `SELECT repeat_reason, body
       FROM agent_dispatch_messages
       WHERE id = $1`,
      [second.messageId]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.repeat_reason).toContain('changes_requested verdict');
    expect(rows.rows[0]?.repeat_reason).toContain('1'.repeat(40));
    expect(rows.rows[0]?.repeat_reason).toContain(secondHeadSha);
    expect(JSON.parse(rows.rows[0]?.body ?? '{}').headSha).toBe(secondHeadSha);
  });

  /**
   * Real-world reproduction (2026-09-02): a `synchronize` push arrives while
   * the FIRST review for that PR is still 'queued' (not yet claimed or
   * terminal) -- the common case, since re-review usually beats the reviewer
   * to the mailbox. Prior coverage only proved the terminal-state case
   * (review already 'done'); this proves the non-terminal case end-to-end
   * against the real dispatch DAL, including that ingest's own stale-head
   * cancellation runs BEFORE the second enqueue rather than racing it.
   */
  test('a synchronize event enqueues a fresh review while the prior review for an older head is still queued', async () => {
    const config = {
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    };
    const deps = createRealIngestDeps(config);

    const payloadFor = (action: 'opened' | 'synchronize', headSha: string): string =>
      JSON.stringify({
        action,
        number: 117,
        pull_request: {
          number: 117,
          draft: false,
          head: { sha: headSha, ref: 'feature-branch' },
          base: { ref: 'dev', sha: 'f'.repeat(40) },
          user: { login: 'bluedevilcollectibles' },
        },
        repository: { name: 'shopops-comic-theme', owner: { login: 'thinmansoftware' } },
      });

    const firstHeadSha = '3'.repeat(40);
    const firstPayload = payloadFor('opened', firstHeadSha);
    const first = await ingestPullRequestEvent(
      {
        rawBody: firstPayload,
        signature: sign(firstPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-nonterminal-1',
      },
      deps
    );
    expect(first.disposition).toBe('queued');

    // Deliberately left 'queued' -- do NOT mark it done/claimed. This is the
    // gap the terminal-state test above does not exercise.
    const priorStatus = await db.query<{ status: string }>(
      `SELECT status FROM agent_dispatch_messages WHERE id = $1`,
      [first.messageId]
    );
    expect(priorStatus.rows[0]?.status).toBe('queued');

    const secondHeadSha = '4'.repeat(40);
    const secondPayload = payloadFor('synchronize', secondHeadSha);
    const second = await ingestPullRequestEvent(
      {
        rawBody: secondPayload,
        signature: sign(secondPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-nonterminal-2',
      },
      deps
    );

    expect(second.disposition).toBe('superseded_head');
    expect(second.messageId).toBeDefined();
    expect(second.messageId).not.toBe(first.messageId);
    expect(second.invalidatedMessageIds).toContain(first.messageId);

    const rows = await db.query<{
      status: string;
      repeat_reason: string | null;
      body: string;
    }>(`SELECT status, repeat_reason, body FROM agent_dispatch_messages WHERE id = $1`, [
      second.messageId,
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.status).toBe('queued');
    expect(rows.rows[0]?.repeat_reason).toBeNull();
    expect(JSON.parse(rows.rows[0]?.body ?? '{}').headSha).toBe(secondHeadSha);

    // The original (older-head) queued row was cancelled, not left dangling.
    const cancelledPriorStatus = await db.query<{ status: string }>(
      `SELECT status FROM agent_dispatch_messages WHERE id = $1`,
      [first.messageId]
    );
    expect(cancelledPriorStatus.rows[0]?.status).toBe('cancelled');
  });

  test('a same-head redelivery while the review is still queued is a duplicate, not a new enqueue', async () => {
    const config = {
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    };
    const deps = createRealIngestDeps(config);
    const headSha = '5'.repeat(40);
    const payload = JSON.stringify({
      action: 'opened',
      number: 200,
      pull_request: {
        number: 200,
        draft: false,
        head: { sha: headSha, ref: 'feature-branch' },
        base: { ref: 'dev', sha: 'f'.repeat(40) },
        user: { login: 'bluedevilcollectibles' },
      },
      repository: { name: 'shopops-comic-theme', owner: { login: 'thinmansoftware' } },
    });

    const first = await ingestPullRequestEvent(
      {
        rawBody: payload,
        signature: sign(payload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-samehead-1',
      },
      deps
    );
    expect(first.disposition).toBe('queued');

    // Same head re-delivered via `synchronize` (e.g. a force-push landing
    // back on the same sha, or a redundant webhook retry with a fresh
    // delivery id) while the first review is still queued.
    const secondPayload = JSON.stringify({
      action: 'synchronize',
      number: 200,
      pull_request: {
        number: 200,
        draft: false,
        head: { sha: headSha, ref: 'feature-branch' },
        base: { ref: 'dev', sha: 'f'.repeat(40) },
        user: { login: 'bluedevilcollectibles' },
      },
      repository: { name: 'shopops-comic-theme', owner: { login: 'thinmansoftware' } },
    });
    const second = await ingestPullRequestEvent(
      {
        rawBody: secondPayload,
        signature: sign(secondPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-samehead-2',
      },
      deps
    );

    expect(second.disposition).toBe('duplicate_delivery');
    expect(second.messageId).toBe(first.messageId);

    const count = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM agent_dispatch_messages WHERE recipient = $1 AND body LIKE $2',
      [REVIEW_RECIPIENT, `%${headSha}%`]
    );
    expect(Number(count.rows[0]?.n ?? 0)).toBe(1);
  });
});
