/**
 * Real-SQLite proof that the stale-verdict sweep can walk a store LARGER THAN
 * ONE PAGE (Overseer review finding, PR #786 @45aa739e).
 *
 * THE BUG THIS PINS. `listMessages` hard-caps its page at 500 rows and offers
 * no offset or cursor. The sweep's first cursor was an in-memory array index
 * applied to that already-fetched page, so every heartbeat re-fetched the same
 * capped slice: once the index passed the candidates inside it the sweep
 * rewound, and any completed review beyond row 500 was permanently unreachable.
 * The live store holds ~4,900 dispatch rows with ~494 on the review recipient
 * alone, so this was not theoretical headroom -- the backstop silently covered
 * only the head of the store.
 *
 * The seeded shape is the finding's own: 1,200 done run_review rows where the
 * ONLY eligible candidate sits at row 1,100, far past any single page.
 *
 * REAL DATABASE ON PURPOSE. A mocked `listCandidates` cannot show this at all:
 * the bug lives in the interaction between the DAL's page cap and the caller's
 * pagination, which only a real query over a real table of real size exercises.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';

let db: SqliteAdapter;
let currentDbPath = '';

mock.module('./connection', () => ({
  getDatabase: () => db,
}));

const { listMessagesBySeqCursor } = await import('./dispatch');
const { readStaleSweepCursor, writeStaleSweepCursor } = await import('./overseer-sweep-cursor');

const REVIEW_RECIPIENT = 'overseer-reviewer';
const TOTAL_ROWS = 1_200;
/** The one row a sweep must reach. Far beyond the 500-row page cap. */
const ELIGIBLE_ROW = 1_100;

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
 * Seed `TOTAL_ROWS` completed run_review items directly, bypassing
 * createAuthenticatedMessage: this test is about PAGINATION over a large table,
 * and the fast raw insert is what makes 1,200 rows practical. `seq` is set
 * explicitly so the ordering is deterministic and independent of rowid healing.
 */
async function seedReviewRows(): Promise<void> {
  for (let index = 1; index <= TOTAL_ROWS; index += 1) {
    const prNumber = index;
    const body = JSON.stringify({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber,
      headSha: `head-${prNumber}`,
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
        `pr-review:thinmansoftware/bdc-harness#${prNumber}@head-${prNumber}`,
        `pr-review:${index}`,
        REVIEW_RECIPIENT,
        body,
        new Date(Date.UTC(2026, 8, 7, 0, 0, 0) + index * 1000).toISOString(),
        index,
      ]
    );
  }
}

describe('listMessagesBySeqCursor over a store larger than one page', () => {
  beforeEach(async () => {
    process.env.BUN_ENV = 'test';
    currentDbPath = join(
      import.meta.dir,
      `.test-seq-cursor-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
    await seedReviewRows();
  });

  afterEach(async () => {
    delete process.env.BUN_ENV;
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('a keyset walk reaches row 1,100 -- unreachable through a single capped page', async () => {
    const pageSize = 100;
    let afterSeq = 0;
    let reachedEligible = false;
    let rowsSeen = 0;
    const pagesRequested: number[] = [];
    // ceil(1200/100) = 12 pages; the loop bound is generous but finite so a
    // non-advancing cursor fails by assertion rather than hanging forever.
    const maxHeartbeats = Math.ceil(TOTAL_ROWS / pageSize) + 2;

    for (let heartbeat = 0; heartbeat < maxHeartbeats; heartbeat += 1) {
      pagesRequested.push(afterSeq);
      const page = await listMessagesBySeqCursor({
        recipient: REVIEW_RECIPIENT,
        task_type: 'run_review',
        status: 'done',
        afterSeq,
        limit: pageSize,
      });
      if (page.length === 0) break;
      rowsSeen += page.length;
      for (const row of page) {
        if (row.correlation_id.includes(`#${ELIGIBLE_ROW}@`)) reachedEligible = true;
      }
      const last = page[page.length - 1];
      // The resume token is a real database position, so the next page is a
      // genuinely different slice.
      expect(last?.cursor_seq).toBeGreaterThan(afterSeq);
      afterSeq = last?.cursor_seq ?? afterSeq;
    }

    // THE REGRESSION GUARD: with the in-memory offset this was false forever,
    // because nothing past the first capped page was ever returned.
    expect(reachedEligible).toBe(true);
    expect(rowsSeen).toBe(TOTAL_ROWS);
    // Every heartbeat asked for a different slice -- no page was re-fetched.
    expect(new Set(pagesRequested).size).toBe(pagesRequested.length);
  });

  test('the page cap alone cannot reach row 1,100, which is why the cursor exists', async () => {
    // One maximal page, no cursor: the DAL caps at 500 however much is asked.
    const single = await listMessagesBySeqCursor({
      recipient: REVIEW_RECIPIENT,
      task_type: 'run_review',
      status: 'done',
      limit: 5_000,
    });
    expect(single).toHaveLength(500);
    expect(single.some(row => row.correlation_id.includes(`#${ELIGIBLE_ROW}@`))).toBe(false);
  });

  test('the cursor resumes strictly after its token, never repeating a row', async () => {
    const first = await listMessagesBySeqCursor({
      recipient: REVIEW_RECIPIENT,
      task_type: 'run_review',
      status: 'done',
      limit: 50,
    });
    const boundary = first[first.length - 1]?.cursor_seq ?? 0;
    const second = await listMessagesBySeqCursor({
      recipient: REVIEW_RECIPIENT,
      task_type: 'run_review',
      status: 'done',
      afterSeq: boundary,
      limit: 50,
    });
    const firstIds = new Set(first.map(row => row.id));
    expect(second.every(row => !firstIds.has(row.id))).toBe(true);
    expect(second[0]?.cursor_seq).toBeGreaterThan(boundary);
  });

  test('task_type and status are filtered in the QUERY, not in memory', async () => {
    // A queued row and a foreign task_type, both on the same recipient.
    await db.query(
      `INSERT INTO agent_dispatch_messages
         (id, correlation_id, idempotency_key, task_type, sender, recipient, body,
          status, created_at, priority, fencing_token, seq)
       VALUES ('msg-queued', 'c-q', 'i-q', 'run_review', 'overseer', $1, '{}', 'queued', $2, 'normal', 0, 9001),
              ('msg-other', 'c-o', 'i-o', 'agent_message', 'overseer', $1, '{}', 'done', $2, 'normal', 0, 9002)`,
      [REVIEW_RECIPIENT, new Date().toISOString()]
    );
    const page = await listMessagesBySeqCursor({
      recipient: REVIEW_RECIPIENT,
      task_type: 'run_review',
      status: 'done',
      afterSeq: 9_000,
      limit: 50,
    });
    // Both new rows sit past the cursor; neither qualifies.
    expect(page).toHaveLength(0);
  });
});

describe('overseer_sweep_cursor durability', () => {
  beforeEach(() => {
    process.env.BUN_ENV = 'test';
    currentDbPath = join(
      import.meta.dir,
      `.test-sweep-cursor-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    delete process.env.BUN_ENV;
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('an unset cursor reads 0 so the first walk starts at the head of the store', async () => {
    expect(await readStaleSweepCursor()).toBe(0);
  });

  test('a written cursor survives a REOPEN -- the point of persisting it', async () => {
    await writeStaleSweepCursor(1_100);
    expect(await readStaleSweepCursor()).toBe(1_100);

    // Simulate an archon-app-1 rebuild: close and reopen the same file. A
    // process-local cursor would rewind to 0 here, which is exactly why rows
    // past one process lifetime's worth of heartbeats were never swept.
    await db.close();
    db = new SqliteAdapter(currentDbPath);
    expect(await readStaleSweepCursor()).toBe(1_100);
  });

  test('writing again overwrites in place, keeping exactly one row', async () => {
    await writeStaleSweepCursor(100);
    await writeStaleSweepCursor(200);
    expect(await readStaleSweepCursor()).toBe(200);
    const rows = await db.query<{ total: unknown }>(
      'SELECT COUNT(*) AS total FROM overseer_sweep_cursor'
    );
    expect(Number(rows.rows[0]?.total)).toBe(1);
  });

  test('a rewind to 0 is persisted, so the next walk restarts at the head', async () => {
    await writeStaleSweepCursor(1_100);
    await writeStaleSweepCursor(0);
    expect(await readStaleSweepCursor()).toBe(0);
  });

  test('a negative or non-finite token is refused rather than stored', async () => {
    await writeStaleSweepCursor(500);
    await writeStaleSweepCursor(-1);
    await writeStaleSweepCursor(Number.NaN);
    expect(await readStaleSweepCursor()).toBe(500);
  });
});
