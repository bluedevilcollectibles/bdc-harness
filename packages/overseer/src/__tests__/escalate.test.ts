import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { join } from 'path';
import { closeDatabase, getOperatorCard, resetDatabase } from '@archon/core/db';
import { assessDispatchMessageBody } from '@archon/core/utils/dispatch-content-guard';
import { buildDispatchRunReportBody, runEscalation } from '../escalate';

describe.serial('durable escalation card', () => {
  let home = '';
  const originalHome = process.env.ARCHON_HOME;
  const originalUrl = process.env.DATABASE_URL;

  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    home = join(import.meta.dir, `.archon-escalate-${Date.now()}-${Math.random()}`);
    process.env.ARCHON_HOME = home;
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    if (originalHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalHome;
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    removeTempDirWithRetry(home);
  });

  test('persists a card whose guarded Dispatch body derives from canonical payload', async () => {
    const card = await runEscalation(
      'run-report-1',
      { decision: 'escalate', reason: 'gate rejected' },
      {
        errorClass: 'validator_rejected',
        woId: 'WO-RPT-01',
        nodeId: 'gate',
        repository: 'thinmansoftware/bdc-harness',
      },
      {
        sourceEventId: 'event-report-1',
        eventType: 'node_failed',
        stepName: 'gate',
        eventCreatedAt: '2026-07-12T00:00:00.000Z',
      }
    );
    const body = buildDispatchRunReportBody(card);
    expect(assessDispatchMessageBody('run_report', body)).toEqual({ allowed: true });
    expect(JSON.parse(body)).toEqual(
      expect.objectContaining({ card_id: card.card_id, payload_digest: card.payload_digest })
    );
  });

  test('deduplicates the same stable source event into one card and three jobs', async () => {
    const args = [
      'run-dedupe',
      { decision: 'escalate' as const, reason: 'unknown failure' },
      {
        errorClass: 'unknown' as const,
        woId: 'WO-DEDUPE-01',
        repository: 'thinmansoftware/bdc-harness',
      },
      {
        sourceEventId: 'event-dedupe-1',
        eventType: 'node_failed',
        stepName: 'verify',
        eventCreatedAt: '2026-07-12T00:00:00.000Z',
      },
    ] as const;
    const first = await runEscalation(...args);
    const second = await runEscalation(...args);
    const view = await getOperatorCard(first.card_id);
    expect(second.card_id).toBe(first.card_id);
    expect(view?.jobs).toHaveLength(3);
  });

  test('rejects an escalation without stable source event identity', async () => {
    await expect(
      runEscalation(
        'run-missing-source',
        { decision: 'escalate', reason: 'unknown failure' },
        { errorClass: 'unknown', woId: 'WO-MISSING-01' },
        {
          sourceEventId: '',
          eventType: 'node_failed',
          stepName: 'verify',
          eventCreatedAt: '2026-07-12T00:00:00.000Z',
        }
      )
    ).rejects.toThrow('operator_card_identity_invalid:source_event_id');
  });
});
