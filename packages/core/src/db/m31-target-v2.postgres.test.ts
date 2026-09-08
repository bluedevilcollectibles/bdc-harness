import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { PostgresAdapter } from './adapters/postgres';

let db: PostgresAdapter;

beforeAll(() => {
  const url = process.env.M31_V2_TEST_DATABASE_URL;
  if (!url) throw new Error('M31_V2_TEST_DATABASE_URL is required');
  db = new PostgresAdapter(url);
  if (db.dialect !== 'postgres') throw new Error('M31 v2 test silently selected non-PostgreSQL');
});

afterAll(async () => {
  await db.close();
});

async function rejectsDatabaseWrite(write: Promise<unknown>): Promise<boolean> {
  try {
    await write;
    return false;
  } catch {
    return true;
  }
}

describe('M31 target v2 PostgreSQL 17 behavior', () => {
  test('real schema has five independent append-only v2 tables and database clock', async () => {
    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'overseer_m31%_v2' ORDER BY table_name"
    );
    expect(tables.rows).toHaveLength(5);
    const now = await db.query<{ now: string }>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`
    );
    expect(Number.isFinite(Date.parse(now.rows[0]?.now ?? ''))).toBe(true);
    const foreignKeys = await db.query<{ referenced_table: string }>(
      `SELECT ccu.table_name AS referenced_table
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema
        WHERE tc.constraint_type='FOREIGN KEY'
          AND tc.table_schema='public'
          AND tc.table_name LIKE 'overseer_m31%_v2'`
    );
    expect(foreignKeys.rows.every(row => row.referenced_table.endsWith('_v2'))).toBe(true);
    const appendOnlyTriggers = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_trigger
        WHERE NOT tgisinternal AND tgname LIKE 'overseer_m31%_v2_append_only'`
    );
    expect(appendOnlyTriggers.rows[0]?.count).toBe('5');
  });

  test('database enforces all 64 action-target pairs', async () => {
    const repository = `test/${randomUUID()}`;
    const snapshotId = `m31v2-snapshot-${randomUUID()}`;
    await db.query(
      `INSERT INTO overseer_m31_snapshots_v2(snapshot_id,schema_version,repository,capture_started_at,capture_completed_at,operator_actor,operator_model,read_only_query_method,evidence_artifact_path,git_object_format,evidence_git_blob,created_at)
       VALUES($1,'m31-target-v2',$2,clock_timestamp(),clock_timestamp(),'test','test','test','test','sha1',$3,clock_timestamp())`,
      [snapshotId, repository, randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40)]
    );
    const actions = [
      'MERGE',
      'CLOSE',
      'REOPEN',
      'REFRESH',
      'REBASE',
      'PUSH',
      'RETARGET',
      'REPAIR',
      'REFIRE',
      'COMMENT',
      'LABEL',
      'ASSIGN',
      'REVIEW',
      'STAGING_MUTATION',
      'PRODUCTION_MUTATION',
      'DEPLOY',
    ] as const;
    const allowed: Record<string, readonly string[]> = {
      workflow_run: ['REPAIR', 'REFIRE'],
      issue: ['CLOSE', 'REOPEN', 'COMMENT', 'LABEL', 'ASSIGN'],
      work_order: ['CLOSE', 'REOPEN', 'COMMENT', 'LABEL', 'ASSIGN'],
      pull_request: [
        'MERGE',
        'CLOSE',
        'REOPEN',
        'REFRESH',
        'REBASE',
        'REPAIR',
        'COMMENT',
        'LABEL',
        'ASSIGN',
      ],
    };
    const pairs = Object.keys(allowed).flatMap(kind =>
      actions.map(action => ({
        kind,
        action,
        permitted: allowed[kind]?.includes(action) ?? false,
        proposalId: `m31v2-proposal-${randomUUID()}`,
        executionId: `m31v2-execution-${randomUUID()}`,
      }))
    );
    const insertPairs = async (selected: typeof pairs) =>
      db.query(
        `INSERT INTO overseer_m31_action_proposals_v2(proposal_id,repository,target_kind,target_key,target_identity_json,target_digest,snapshot_id,evidence_path,evidence_git_blob,action_kind,action_parameters_json,actor,created_at,expires_at,execution_id,capability,policy_digest,verifier_registry_digest)
         SELECT p.proposal_id,$1,p.kind,$1 || '#' || p.kind || ':1','{}','${'a'.repeat(64)}',$2,'test','${'b'.repeat(40)}',p.action,'{}','test',clock_timestamp(),clock_timestamp()+interval '15 minutes',p.execution_id,'overseer.m31.' || lower(p.action),'${'c'.repeat(64)}','${'d'.repeat(64)}'
         FROM jsonb_to_recordset($3::jsonb) AS p(proposal_id text, execution_id text, kind text, action text)`,
        [
          repository,
          snapshotId,
          JSON.stringify(
            selected.map(({ proposalId, executionId, kind, action }) => ({
              proposal_id: proposalId,
              execution_id: executionId,
              kind,
              action,
            }))
          ),
        ]
      );

    const permitted = pairs.filter(pair => pair.permitted);
    const denied = pairs.filter(pair => !pair.permitted);
    expect(permitted).toHaveLength(21);
    expect(denied).toHaveLength(43);
    await insertPairs(permitted);
    let deniedByDatabase = false;
    try {
      await insertPairs(denied);
    } catch {
      deniedByDatabase = true;
    }
    expect(deniedByDatabase).toBe(true);
    const stored = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM overseer_m31_action_proposals_v2 WHERE repository=$1',
      [repository]
    );
    expect(stored.rows[0]?.count).toBe('21');
  });

  test('two independent PostgreSQL connections produce one snapshot CAS winner', async () => {
    const url = process.env.M31_V2_TEST_DATABASE_URL;
    if (!url) throw new Error('M31_V2_TEST_DATABASE_URL is required');
    const second = new PostgresAdapter(url);
    const repository = `race/${randomUUID()}`;
    const insertGenesis = (adapter: PostgresAdapter, seed: string) =>
      adapter.withTransaction(async query => {
        await query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        await query("SELECT pg_advisory_xact_lock(hashtextextended('m31v2:' || $1, 0))", [
          repository,
        ]);
        await query(
          `INSERT INTO overseer_m31_snapshots_v2(snapshot_id,schema_version,repository,capture_started_at,capture_completed_at,operator_actor,operator_model,read_only_query_method,evidence_artifact_path,git_object_format,evidence_git_blob,created_at)
           VALUES($1,'m31-target-v2',$2,clock_timestamp(),clock_timestamp(),'test','test','test','test','sha1',$3,clock_timestamp())`,
          [`m31v2-snapshot-${randomUUID()}`, repository, seed.repeat(40)]
        );
      });
    try {
      const race = await Promise.allSettled([insertGenesis(db, 'e'), insertGenesis(second, 'f')]);
      expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(race.filter(result => result.status === 'rejected')).toHaveLength(1);
      const tips = await db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM overseer_m31_snapshots_v2 WHERE repository=$1',
        [repository]
      );
      expect(tips.rows[0]?.count).toBe('1');
    } finally {
      await second.close();
    }
  });

  test('append-only discrepancy resolution and receipt ordering are enforced by PostgreSQL', async () => {
    const repository = `behavior/${randomUUID()}`;
    const snapshotId = `m31v2-snapshot-${randomUUID()}`;
    const proposalId = `m31v2-proposal-${randomUUID()}`;
    const executionId = `m31v2-execution-${randomUUID()}`;
    const targetKey = `${repository}#issue:1`;
    await db.query(
      `INSERT INTO overseer_m31_snapshots_v2(snapshot_id,schema_version,repository,capture_started_at,capture_completed_at,operator_actor,operator_model,read_only_query_method,evidence_artifact_path,git_object_format,evidence_git_blob,created_at)
       VALUES($1,'m31-target-v2',$2,clock_timestamp(),clock_timestamp(),'test','test','test','test','sha1',$3,clock_timestamp())`,
      [snapshotId, repository, '1'.repeat(40)]
    );
    await db.query(
      `INSERT INTO overseer_m31_target_members_v2(snapshot_id,ordinal,target_kind,target_key,target_identity_json,target_digest,evidence_artifact_path,git_object_format,evidence_git_blob,observed_at)
       VALUES($1,0,'issue',$2,'{}',$3,'test','sha1',$4,clock_timestamp())`,
      [snapshotId, targetKey, '2'.repeat(64), '3'.repeat(40)]
    );
    const openId = `m31v2-discrepancy-${randomUUID()}`;
    await db.query(
      `INSERT INTO overseer_m31_discrepancies_v2(discrepancy_id,snapshot_id,evidence_git_blob,affected_targets_json,conflict_json,recorded_by,recorded_at)
       VALUES($1,$2,$3,$4,$5,'test',clock_timestamp())`,
      [
        openId,
        snapshotId,
        '4'.repeat(40),
        JSON.stringify([targetKey]),
        JSON.stringify({ state: 'changed' }),
      ]
    );
    const resolutionId = `m31v2-discrepancy-${randomUUID()}`;
    await db.query(
      `INSERT INTO overseer_m31_discrepancies_v2(discrepancy_id,snapshot_id,evidence_git_blob,affected_targets_json,conflict_json,recorded_by,recorded_at,resolution_json,resolved_by,resolved_at,predecessor_discrepancy_id)
       VALUES($1,$2,$3,$4,$5,'test',clock_timestamp(),$6,'test',clock_timestamp(),$7)`,
      [
        resolutionId,
        snapshotId,
        '5'.repeat(40),
        JSON.stringify([targetKey]),
        JSON.stringify({ state: 'changed' }),
        JSON.stringify({
          resolves_discrepancy_id: openId,
          resolution_code: 'live_state_reconciled',
          evidence_digest: '6'.repeat(64),
        }),
        openId,
      ]
    );
    expect(
      await rejectsDatabaseWrite(
        db.query(
          `INSERT INTO overseer_m31_discrepancies_v2(discrepancy_id,snapshot_id,evidence_git_blob,affected_targets_json,conflict_json,recorded_by,recorded_at,resolution_json,resolved_by,resolved_at,predecessor_discrepancy_id)
           VALUES($1,$2,$3,$4,$5,'test',clock_timestamp(),$6,'test',clock_timestamp(),$7)`,
          [
            `m31v2-discrepancy-${randomUUID()}`,
            snapshotId,
            '7'.repeat(40),
            JSON.stringify([targetKey]),
            JSON.stringify({ state: 'changed' }),
            JSON.stringify({
              resolves_discrepancy_id: openId,
              resolution_code: 'duplicate',
              evidence_digest: '8'.repeat(64),
            }),
            resolutionId,
          ]
        )
      )
    ).toBe(true);
    await db.query(
      `INSERT INTO overseer_m31_action_proposals_v2(proposal_id,repository,target_kind,target_key,target_identity_json,target_digest,snapshot_id,evidence_path,evidence_git_blob,action_kind,action_parameters_json,actor,created_at,expires_at,execution_id,capability,policy_digest,verifier_registry_digest)
       VALUES($1,$2,'issue',$3,'{}',$4,$5,'test',$6,'COMMENT','{}','test',clock_timestamp(),clock_timestamp()+interval '15 minutes',$7,'overseer.m31.comment',$8,$9)`,
      [
        proposalId,
        repository,
        targetKey,
        '2'.repeat(64),
        snapshotId,
        '9'.repeat(40),
        executionId,
        'a'.repeat(64),
        'b'.repeat(64),
      ]
    );
    const receipt = (sequence: number, type: string, previous: string | null, digest: string) =>
      db.query(
        `INSERT INTO overseer_m31_execution_receipts_v2(receipt_event_id,proposal_id,execution_id,event_sequence,event_type,target_kind,target_key,target_digest,live_observation_json,live_observation_digest,revalidated_at,valid_until,adapter_name,provider_operation,reason,evidence_json,previous_event_digest,event_digest,created_at)
         VALUES($1,$2,$3,$4,$5,'issue',$6,$7,$8,$9,$10,$11,$12,$13,'test','{}',$14,$15,clock_timestamp())`,
        [
          `m31v2-receipt-${randomUUID()}`,
          proposalId,
          executionId,
          sequence,
          type,
          targetKey,
          '2'.repeat(64),
          sequence === 1 ? '{}' : null,
          sequence === 1 ? 'c'.repeat(64) : null,
          sequence === 1 ? new Date().toISOString() : null,
          sequence === 1 ? new Date(Date.now() + 60_000).toISOString() : null,
          sequence === 2 ? 'fake' : null,
          sequence === 2 ? 'comment' : null,
          previous,
          digest,
        ]
      );
    expect(await rejectsDatabaseWrite(receipt(2, 'effect_reserved', null, 'd'.repeat(64)))).toBe(
      true
    );
    await receipt(1, 'permit_issued', null, 'e'.repeat(64));
    await receipt(2, 'effect_reserved', 'e'.repeat(64), 'f'.repeat(64));
    await receipt(3, 'effect_succeeded', 'f'.repeat(64), '0'.repeat(64));
    expect(
      await rejectsDatabaseWrite(
        receipt(4, 'effect_reconciled_failed', '0'.repeat(64), '1'.repeat(64))
      )
    ).toBe(true);
    for (const [table, column] of [
      ['overseer_m31_snapshots_v2', 'created_at'],
      ['overseer_m31_target_members_v2', 'observed_at'],
      ['overseer_m31_discrepancies_v2', 'recorded_at'],
      ['overseer_m31_action_proposals_v2', 'created_at'],
      ['overseer_m31_execution_receipts_v2', 'created_at'],
    ]) {
      expect(await rejectsDatabaseWrite(db.query(`UPDATE ${table} SET ${column}=${column}`))).toBe(
        true
      );
      expect(await rejectsDatabaseWrite(db.query(`DELETE FROM ${table}`))).toBe(true);
    }
  });
});
