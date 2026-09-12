import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { evidenceSpecSchema, registerExpectationBodySchema } from './schemas/taskmaster.schemas';

const apiSource = readFileSync(join(import.meta.dir, 'api.ts'), 'utf8');

/**
 * bdc-xo#2007. The registry shipped with #1850 and every live row was written
 * by the loop itself; there was no way for a session to say "I gave this work
 * to that seat, check on me", so registering one meant sudo sqlite3 on the
 * production host. These tests hold the front door open.
 */
describe('expectation front door: route wiring', () => {
  test('both routes are mounted', () => {
    expect(apiSource).toContain('registerOpenApiRoute(postTaskmasterExpectationRoute');
    expect(apiSource).toContain('registerOpenApiRoute(getTaskmasterExpectationsRoute');
  });

  test('the POST declares its refusals, so a caller is not surprised by them', () => {
    const declaration = apiSource.slice(
      apiSource.indexOf('const postTaskmasterExpectationRoute'),
      apiSource.indexOf('const getTaskmasterExpectationsRoute')
    );
    expect(declaration).toContain("401: jsonError('Missing or invalid operator token')");
    expect(declaration).toMatch(/400: jsonError\(/);
    expect(declaration).toMatch(/429: jsonError\(/);
  });

  test('registration is namespaced, so an external key cannot collide with a loop key', () => {
    // The loop's keys are "<action id>:<dispatch_ref>" or a bare dispatch_ref.
    // Without the prefix, a caller could name a key that adopts or blocks the
    // row the loop opened for one of its own dispatches.
    expect(apiSource).toContain('`ext:${body.registered_by}:${body.registration_key}`');
  });

  test('the handler enforces exactly one deadline form', () => {
    const handler = apiSource.slice(
      apiSource.indexOf('// POST /api/taskmaster/expectations -'),
      apiSource.indexOf('// GET /api/taskmaster/expectations -')
    );
    expect(handler).toContain('Provide exactly one of due_at or due_in_minutes');
    // A deadline already past asks the very next tick to call the work absent.
    expect(handler).toContain('due_at must be in the future');
  });

  test('self-supervised escalation is refused in code, not merely documented', () => {
    const handler = apiSource.slice(
      apiSource.indexOf('// POST /api/taskmaster/expectations -'),
      apiSource.indexOf('// GET /api/taskmaster/expectations -')
    );
    expect(handler).toContain('A registrant cannot escalate against itself');
    expect(handler).toMatch(/selfSupervised && body\.on_absence === 'escalate'/);
  });

  test('the cap is token-wide, because registered_by is self-declared', () => {
    // Overseer finding [major] on PR 810: a per-registrant cap bounds nothing
    // when the registrant is a string in the request body -- a caller at its
    // limit sends a different name. The enforced count is of every ext: row.
    const handler = apiSource.slice(
      apiSource.indexOf('// POST /api/taskmaster/expectations -'),
      apiSource.indexOf('// GET /api/taskmaster/expectations -')
    );
    expect(handler).toContain('daily_cap: EXPECTATION_DAILY_CAP');
    expect(handler).not.toContain('countExpectationsRegisteredSince');
    expect(apiSource).toContain('EXPECTATION_DAILY_CAP');
  });

  test('a retry of an existing key never consumes the cap', () => {
    // Overseer finding [minor] on PR 810: charging a retry would turn the
    // documented idempotent 200 into a 429 the moment a caller got busy.
    const handler = apiSource.slice(
      apiSource.indexOf('// POST /api/taskmaster/expectations -'),
      apiSource.indexOf('// GET /api/taskmaster/expectations -')
    );
    expect(handler).toContain('expectationKeyExists');
    expect(handler).toContain('cap_exempt: capExempt');
  });

  test('the cap is enforced in the write, not by a count before it', () => {
    // Overseer finding [major], round 2: a count taken in the route and an
    // insert taken after it let concurrent callers all read a count below the
    // cap and all then write. The route must hand the cap to the DAL, which
    // evaluates it as a predicate inside the INSERT. Behavioural proof that this
    // actually holds under concurrency lives in the DAL test
    // ('CONCURRENT registrations cannot exceed the cap').
    const handler = apiSource.slice(
      apiSource.indexOf('// POST /api/taskmaster/expectations -'),
      apiSource.indexOf('// GET /api/taskmaster/expectations -')
    );
    expect(handler).toContain('daily_cap: EXPECTATION_DAILY_CAP');
    // The route must NOT decide admission from its own count.
    expect(handler).not.toContain('countExternalExpectationsSince');
    expect(handler).toContain('if (result.capped)');
  });

  test('the self-supervision guard is documented as a correctness check, not a boundary', () => {
    // Both sides come from the request body, so it cannot hold against a caller
    // trying to get around it. Saying so in the source is what stops a future
    // reader treating it as a security control it is not.
    const handler = apiSource.slice(
      apiSource.indexOf('// POST /api/taskmaster/expectations -'),
      apiSource.indexOf('// GET /api/taskmaster/expectations -')
    );
    expect(handler).toContain('CORRECTNESS guard, not a security control');
  });

  test('the GET surface is read-only', () => {
    const handler = apiSource.slice(
      apiSource.indexOf('// GET /api/taskmaster/expectations -'),
      apiSource.indexOf('// POST /api/taskmaster/resume -')
    );
    expect(handler).not.toMatch(/registerExpectation|markMet|markFailed|markEscalated/);
  });
});

describe('expectation front door: the contract', () => {
  test('all six evidence kinds #1850 specified are reachable', () => {
    // THE GAP. checkEvidence has implemented all six since #1850, but the live
    // rows used only dispatch_reply_exists -- the other five were code nothing
    // could reach. The schema is what makes them reachable, so this test is the
    // thing that keeps them so.
    const kinds = [
      { kind: 'issue_comment_exists', repo: 'a/b', number: 1 },
      { kind: 'label_present', repo: 'a/b', number: 1, label: 'status:review' },
      { kind: 'pr_opened', repo: 'thinmansoftware/fuelglass' },
      { kind: 'lease_holder_is', name: 'xo-main' },
      { kind: 'dispatch_reply_exists', correlation_id: 'c1' },
      { kind: 'db_row_exists', table: 'runs', where: { id: 'r1' } },
    ];
    for (const spec of kinds) {
      const parsed = evidenceSpecSchema.safeParse(spec);
      expect(parsed.success).toBe(true);
    }
    expect(kinds).toHaveLength(6);
  });

  test('an unknown evidence kind is refused at registration, not at the deadline', () => {
    // Refusing late would leave an expectation that can never be satisfied and
    // escalates for work that may well have been done.
    expect(evidenceSpecSchema.safeParse({ kind: 'vibes', repo: 'a/b' }).success).toBe(false);
  });

  test('db_row_exists rejects an identifier that is not an identifier', () => {
    expect(
      evidenceSpecSchema.safeParse({
        kind: 'db_row_exists',
        table: 'runs; DROP TABLE tm_expectations',
        where: { id: 'r1' },
      }).success
    ).toBe(false);
    expect(
      evidenceSpecSchema.safeParse({
        kind: 'db_row_exists',
        table: 'runs',
        where: { 'id = 1 OR 1': 'x' },
      }).success
    ).toBe(false);
  });

  test('db_row_exists accepts the null and IN predicate forms checkEvidence implements', () => {
    const parsed = evidenceSpecSchema.safeParse({
      kind: 'db_row_exists',
      table: 'remote_agent_workflow_runs',
      where: { cascade_id: 'abc', status: ['completed', 'succeeded'], failed_at: null },
    });
    expect(parsed.success).toBe(true);
  });

  test('registration_key is required: the server cannot invent idempotency', () => {
    const withoutKey = registerExpectationBodySchema.safeParse({
      dispatch_ref: 'bdc-xo#2006',
      recipient: 'fable-cursor',
      evidence: { kind: 'pr_opened', repo: 'a/b' },
      due_in_minutes: 1440,
    });
    expect(withoutKey.success).toBe(false);
  });

  test('defaults are the safe ones: escalate, no retries, attributed caller', () => {
    const parsed = registerExpectationBodySchema.parse({
      registration_key: 'fuelglass-1',
      dispatch_ref: 'bdc-xo#2006',
      recipient: 'fable-cursor',
      evidence: { kind: 'pr_opened', repo: 'a/b' },
      due_in_minutes: 1440,
    });
    // An unspecified absence action must be the one that TELLS SOMEONE.
    expect(parsed.on_absence).toBe('escalate');
    expect(parsed.max_retries).toBe(0);
    expect(parsed.registered_by).toBe('operator');
  });

  test('max_retries is bounded, so one registration cannot buy unbounded sends', () => {
    const tooMany = registerExpectationBodySchema.safeParse({
      registration_key: 'fuelglass-1',
      dispatch_ref: 'bdc-xo#2006',
      recipient: 'fable-cursor',
      evidence: { kind: 'pr_opened', repo: 'a/b' },
      due_in_minutes: 1440,
      max_retries: 99,
    });
    expect(tooMany.success).toBe(false);
  });

  test('due_in_minutes is bounded to 30 days', () => {
    expect(
      registerExpectationBodySchema.safeParse({
        registration_key: 'k-12345678',
        dispatch_ref: 'r',
        recipient: 'x',
        evidence: { kind: 'pr_opened', repo: 'a/b' },
        due_in_minutes: 43_201,
      }).success
    ).toBe(false);
  });
});

describe('the composite key cannot collide (Overseer PR 810 round 4)', () => {
  const valid = {
    dispatch_ref: 'bdc-xo#2006',
    recipient: 'fable-cursor',
    evidence: { kind: 'pr_opened' as const, repo: 'thinmansoftware/fuelglass' },
    due_in_minutes: 1440,
  };

  test('THE COLLISION: the two inputs that used to render the same key are both refused', () => {
    // `ext:${registered_by}:${registration_key}` is ambiguous the moment either
    // component may contain ':'. These two distinct requests both rendered
    // `ext:xo:a:12345678`, so the second was handed the FIRST one's row with
    // created:false and ITS deadline -- told its work was supervised when
    // nothing was watching it. That is the precise failure this registry exists
    // to prevent, so it must be refused at the door.
    const a = registerExpectationBodySchema.safeParse({
      ...valid,
      registered_by: 'xo:a',
      registration_key: '12345678',
    });
    const b = registerExpectationBodySchema.safeParse({
      ...valid,
      registered_by: 'xo',
      registration_key: 'a:12345678',
    });
    expect(a.success).toBe(false);
    expect(b.success).toBe(false);
    // And prove the collision was real, so this test cannot quietly become
    // vacuous if the construction changes.
    expect(`ext:${'xo:a'}:${'12345678'}`).toBe(`ext:${'xo'}:${'a:12345678'}`);
  });

  test('a colon is refused in either component, wherever it sits', () => {
    for (const [registered_by, registration_key] of [
      ['x:o', 'abcdefgh'],
      ['xo', 'abcd:efgh'],
      [':xo', 'abcdefgh'],
      ['xo:', 'abcdefgh'],
      ['xo', ':abcdefgh'],
      ['xo', 'abcdefgh:'],
    ]) {
      const parsed = registerExpectationBodySchema.safeParse({
        ...valid,
        registered_by,
        registration_key,
      });
      expect(parsed.success).toBe(false);
    }
  });

  test('whitespace is refused too, so a key cannot be two keys in a log line', () => {
    expect(
      registerExpectationBodySchema.safeParse({
        ...valid,
        registration_key: 'abcd efgh',
      }).success
    ).toBe(false);
    expect(
      registerExpectationBodySchema.safeParse({ ...valid, registered_by: 'x o' }).success
    ).toBe(false);
  });

  test('the shapes real callers actually use still parse', () => {
    // The constraint must not break the wrapper's own key shape, which is
    // "<ref>-<digest>" with the ref sanitized to [A-Za-z0-9#._-].
    for (const key of [
      'bdc-xo#2006-72d3968715658a55',
      'fuelglass-2006',
      'WO-HARNESS-TASKMASTER-01',
      'thinmansoftware/fuelglass@main',
      'a.b_c+d-long-enough',
    ]) {
      const parsed = registerExpectationBodySchema.safeParse({
        ...valid,
        registration_key: key,
      });
      expect(parsed.success).toBe(true);
    }
    for (const who of ['xo', 'fable-cursor', 'codex', 'xo.main', 'claude+acp']) {
      // An explicit key here: the `valid` fixture carries none, and a missing
      // one would make every iteration fail for the wrong reason.
      const parsed = registerExpectationBodySchema.safeParse({
        ...valid,
        registration_key: 'abcdefgh',
        registered_by: who,
      });
      expect(parsed.success).toBe(true);
    }
  });

  test('distinct inputs still produce distinct keys', () => {
    const render = (by: string, key: string): string => `ext:${by}:${key}`;
    const keys = new Set([
      render('xo', 'abcdefgh'),
      render('xo', 'abcdefgi'),
      render('codex', 'abcdefgh'),
      render('xo-a', 'abcdefgh'),
      render('xo', 'a-abcdefgh'),
    ]);
    expect(keys.size).toBe(5);
  });
});
