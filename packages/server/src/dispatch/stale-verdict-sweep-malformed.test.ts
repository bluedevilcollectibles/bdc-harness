/**
 * Real-SQLITE proof that a block of UNPARSEABLE review rows cannot starve the
 * stale-verdict walk (Overseer review finding, PR #786 @e80159e4).
 *
 * THE BUG THIS PINS. `listRealSweepCandidates` returned only the candidates
 * that PARSED, and exposed no position for the rows it discarded. So a page
 * whose rows all failed parse/validation was indistinguishable from the end of
 * the store: `runStaleVerdictSweep` saw an empty list, rewound the cursor to 0,
 * and did exactly the same thing on the next heartbeat. Valid candidates
 * sitting beyond the malformed block were unreachable forever.
 *
 * NOT HYPOTHETICAL. Live store, read 2026-09-08: 8 of 423 completed
 * `run_review` rows already carry unparseable or incomplete bodies, so the
 * discard path runs in production today.
 *
 * The seeded shape is the finding's own: 60 done run_review rows where rows
 * 1-50 have unparseable bodies and the only eligible candidate is row 55.
 *
 * REAL DATABASE ON PURPOSE. The bug lives in the seam between the DAL's raw
 * page and the wiring's parsed output; a mocked lister cannot show it.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';

let db: SqliteAdapter;
let currentDbPath = '';

mock.module('@archon/core/db/connection', () => ({
  getDatabase: () => db,
}));

const { listRealSweepCandidates } = await import('./stale-verdict-sweep-wiring');
const { runStaleVerdictSweep, createMemorySweepCursor } = await import('./stale-verdict-sweep');

const REVIEW_RECIPIENT = 'overseer-reviewer';
const TOTAL_ROWS = 60;
/** Rows 1..50 are malformed -- a full default page of them. */
const MALFORMED_THROUGH = 50;
/** The only row that can ever become a candidate. */
const ELIGIBLE_ROW = 55;

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

/**
 * Seed 60 completed run_review rows. Rows 1-50 carry bodies the review-work
 * parser rejects; rows 51-60 are well-formed, and only row 55 is wired to be
 * the eligible one in the sweep test below.
 *
 * Two distinct malformed shapes on purpose, because production has both: bodies
 * that are not valid JSON at all, and bodies that parse but lack the required
 * owner/repo/prNumber/headSha fields.
 */
async function seedRows(): Promise<void> {
  for (let index = 1; index <= TOTAL_ROWS; index += 1) {
    const malformed = index <= MALFORMED_THROUGH;
    const body = malformed
      ? index % 2 === 0
        ? '{ this is not json'
        : JSON.stringify({ note: 'parses, but carries no review fields' })
      : JSON.stringify({
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
          prNumber: index,
          headSha: `head-${index}`,
          baseRef: 'dev',
          author: 'bluedevilcollectibles',
        });
    await db.query(
      `INSERT INTO agent_dispatch_messages
         (id, correlation_id, idempotency_key, task_type, sender, recipient, body,
          status, created_at, priority, fencing_token, seq)
       VALUES ($1, $2, $3, 'run_review', 'overseer', $4, $5, 'done', $6, 'normal', 0, $7)`,
      [
        `msg-${index}`,
        `pr-review:thinmansoftware/bdc-harness#${index}@head-${index}`,
        `pr-review:${index}`,
        REVIEW_RECIPIENT,
        body,
        new Date(Date.UTC(2026, 8, 8, 0, 0, 0) + index * 1000).toISOString(),
        index,
      ]
    );
  }
}

describe('listRealSweepCandidates over a block of unparseable rows', () => {
  beforeEach(async () => {
    process.env.BUN_ENV = 'test';
    currentDbPath = join(
      import.meta.dir,
      `.test-sweep-malformed-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
    await seedRows();
  });

  afterEach(async () => {
    delete process.env.BUN_ENV;
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('a page of only-malformed rows reports its raw position, not an empty list', async () => {
    // limit 3 -> raw fetch of 50, which lands entirely inside the malformed block.
    const page = await listRealSweepCandidates(3, 0);

    expect(page.candidates).toHaveLength(0);
    expect(page.rawCount).toBe(MALFORMED_THROUGH);
    expect(page.discarded).toBe(MALFORMED_THROUGH);
    // THE REGRESSION GUARD: the raw position of the last row examined. Without
    // it the caller cannot tell this page from the end of the store.
    expect(page.lastRawSeq).toBe(MALFORMED_THROUGH);
  });

  test('resuming past the malformed block returns the well-formed rows', async () => {
    const page = await listRealSweepCandidates(3, MALFORMED_THROUGH);

    expect(page.candidates.length).toBeGreaterThan(0);
    expect(page.discarded).toBe(0);
    expect(page.candidates[0]?.prNumber).toBe(MALFORMED_THROUGH + 1);
  });

  test('a genuinely exhausted cursor reports zero raw rows', async () => {
    const page = await listRealSweepCandidates(3, TOTAL_ROWS);

    expect(page.rawCount).toBe(0);
    expect(page.candidates).toHaveLength(0);
    expect(page.lastRawSeq).toBe(0);
  });
});

describe('the sweep walks past malformed rows across heartbeats', () => {
  beforeEach(async () => {
    process.env.BUN_ENV = 'test';
    currentDbPath = join(
      import.meta.dir,
      `.test-sweep-walk-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
    await seedRows();
  });

  afterEach(async () => {
    delete process.env.BUN_ENV;
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('row 55 is reached on the SECOND heartbeat, with no rewind after the first', async () => {
    const enqueued: number[] = [];
    const deps = {
      listCandidates: listRealSweepCandidates,
      // Only row 55 carries an authorizing, stale verdict.
      readStandingVerdict: async (candidate: { prNumber: number; headSha: string }) =>
        candidate.prNumber === ELIGIBLE_ROW
          ? {
              headSha: candidate.headSha,
              disposition: 'changes_requested',
              summary: '[major] checks/test (windows-latest): required check failed',
              recordedAt: '2026-09-08T12:00:00.000Z',
            }
          : {
              headSha: candidate.headSha,
              disposition: 'approved',
              summary: 'No blocking findings.',
              recordedAt: '2026-09-08T12:00:00.000Z',
            },
      readLatestCheckCompletion: async () => ({
        checkId: 'check_run:555',
        checkName: 'test (windows-latest)',
        conclusion: 'success',
        completedAt: '2026-09-08T16:00:00.000Z',
      }),
      enqueueRecheckWork: async (input: { prNumber: number }) => {
        enqueued.push(input.prNumber);
        return { messageId: `msg-${input.prNumber}`, alreadyExisted: false };
      },
    };
    const cursor = createMemorySweepCursor();

    // HEARTBEAT 1: the raw page is the 50-row malformed block. Nothing parses,
    // so nothing is examined -- but the walk must still move.
    const first = await runStaleVerdictSweep(deps, 3, cursor);
    expect(first.examined).toBe(0);
    expect(first.enqueued).toBe(0);
    expect(first.discarded).toBe(MALFORMED_THROUGH);
    // THE REGRESSION GUARD: before the fix this rewound to 0 every time.
    expect(first.afterSeq).toBe(MALFORMED_THROUGH);
    expect(await cursor.read()).toBe(MALFORMED_THROUGH);

    // HEARTBEAT 2: resumes past the block and finds the eligible row.
    const second = await runStaleVerdictSweep(deps, 3, cursor);
    expect(await cursor.read()).toBeGreaterThan(MALFORMED_THROUGH);
    expect(second.enqueued + first.enqueued).toBe(1);
    expect(enqueued).toEqual([ELIGIBLE_ROW]);
  });

  test('the walk still rewinds once the store is genuinely exhausted', async () => {
    const deps = {
      listCandidates: listRealSweepCandidates,
      readStandingVerdict: async (candidate: { headSha: string }) => ({
        headSha: candidate.headSha,
        disposition: 'approved',
        summary: 'No blocking findings.',
        recordedAt: '2026-09-08T12:00:00.000Z',
      }),
      readLatestCheckCompletion: async () => null,
      enqueueRecheckWork: async () => ({ messageId: 'unused', alreadyExisted: true }),
    };
    // A cursor already past every seeded row: zero RAW rows come back, which is
    // the only condition that may rewind.
    const cursor = createMemorySweepCursor(TOTAL_ROWS);

    const result = await runStaleVerdictSweep(deps, 3, cursor);

    expect(result.afterSeq).toBe(0);
    expect(await cursor.read()).toBe(0);
  });
});
