/**
 * Tests for the silent-dead-end failure classes added by
 * WO-HARNESS-OVERSEER-FAILURE-CLASSES-EXPANSION-01.
 *
 * Anchor incidents (2026-05-18 Wave A):
 *   - WO-AUTH-RETIRE-GAS-PATH-02: commit-and-push exit 1 with implement-loop-no-output
 *     stderr; downstream nodes skipped; no Notion/webhook/escalation signal.
 *   - WO-AUTH-SINGLE-PATH-E2E-04: validator emitted actionable remediation; agent did
 *     not iterate; commit-and-push saw clean tree and silently exited 1.
 *
 * Coverage:
 *   1. classify implement_loop_no_output (stderr alone, no validator context)
 *   2. classify validator_feedback_not_applied (stderr + validator action verbs)
 *   3. classify validator_rejected (validator stdout begins with REJECT)
 *   4. runEscalation side-effects integration (escalation.json + webhook + Notion)
 *   5. end-to-end: WO-AUTH-SINGLE-PATH-E2E-04 incident replay through decide+escalate
 */

import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyError, decide, runEscalation } from '../src/index.ts';
import type { EscalationContext } from '../src/escalate.ts';

// --- Test 1 — implement_loop_no_output classification ------------------------

describe('classify: implement_loop_no_output', () => {
  test('commit-and-push stderr alone (no validator context) classifies as implement_loop_no_output', () => {
    const result = classifyError({
      message:
        'No changed files and no commits ahead of origin/feat/WO-FOO-01 -- implement loop did not produce work',
      nodeId: 'commit-and-push',
      nodeType: 'bash',
      exitCode: 1,
    });
    expect(result).toBe('implement_loop_no_output');
  });

  test('implement_loop_no_output decision is escalate with escalationContext', () => {
    const result = decide({
      errorClass: 'implement_loop_no_output',
      attempt: 1,
      nodeId: 'commit-and-push',
      woId: 'WO-FOO-01',
    });
    expect(result.decision).toBe('escalate');
    expect(result.escalationContext).toBeDefined();
    expect(result.escalationContext?.errorClass).toBe('implement_loop_no_output');
    expect(result.escalationContext?.woId).toBe('WO-FOO-01');
  });
});

// --- Test 2 — validator_feedback_not_applied classification ------------------

describe('classify: validator_feedback_not_applied', () => {
  test('same stderr as no_output but with validator action verbs in context classifies as validator_feedback_not_applied', () => {
    const result = classifyError({
      message:
        'No changed files and no commits ahead of origin/feat/WO-AUTH-SINGLE-PATH-E2E-04 -- implement loop did not produce work',
      nodeId: 'commit-and-push',
      nodeType: 'bash',
      exitCode: 1,
      validatorOutput:
        "Add lspro_token to scenario 6b's addInitScript (currently causes redirect to /login).\nPR body must include the local run command per stop condition 5.",
      threadCommitsAhead: 1,
    });
    expect(result).toBe('validator_feedback_not_applied');
  });

  test('validator_feedback_not_applied decision carries remediation list in escalationContext', () => {
    const result = decide({
      errorClass: 'validator_feedback_not_applied',
      attempt: 1,
      nodeId: 'commit-and-push',
      woId: 'WO-AUTH-SINGLE-PATH-E2E-04',
      validatorOutput:
        "- Add lspro_token to scenario 6b's addInitScript\n- PR body must include the local run command",
    });
    expect(result.decision).toBe('escalate');
    expect(result.escalationContext?.errorClass).toBe('validator_feedback_not_applied');
    const remediation = result.escalationContext?.remediation;
    expect(Array.isArray(remediation)).toBe(true);
    expect(remediation?.length).toBe(2);
    expect(remediation?.[0]).toContain('lspro_token');
  });

  test('REJECT in validator output wins over action verbs (precedence)', () => {
    // Spec requirement: REJECT/BLOCK/FAIL signals validator_rejected even if the same
    // text also contains action verbs like "must". Order in classify.ts puts REJECT
    // check before the action-verb branch for exactly this reason.
    const result = classifyError({
      message:
        'No changed files and no commits ahead of origin/feat/WO-FOO -- implement loop did not produce work',
      nodeId: 'commit-and-push',
      validatorOutput: 'REJECT: must rewrite the auth flow from scratch',
    });
    expect(result).toBe('validator_rejected');
  });
});

// --- Test 3 — validator_rejected classification ------------------------------

describe('classify: validator_rejected', () => {
  test('war-council-validator stdout starting with REJECT classifies as validator_rejected', () => {
    const result = classifyError({
      message: 'REJECT: cannot proceed -- schema mismatch',
      nodeId: 'war-council-validator',
      exitCode: 0,
    });
    expect(result).toBe('validator_rejected');
  });

  test('BLOCK at line start also classifies as validator_rejected', () => {
    const result = classifyError({
      message: 'BLOCK: missing test coverage for scenario 4',
      nodeId: 'war-council-validator',
    });
    expect(result).toBe('validator_rejected');
  });

  test('FAIL at line start also classifies as validator_rejected', () => {
    const result = classifyError({
      message: 'FAIL: pre-existing rot in @archon/paths',
      nodeId: 'war-council-validator',
    });
    expect(result).toBe('validator_rejected');
  });

  test('REJECT in validatorOutput context (downstream node failure) classifies as validator_rejected', () => {
    const result = classifyError({
      message: 'some downstream failure',
      nodeId: 'commit-and-push',
      validatorOutput: 'REJECT: schema mismatch detected',
    });
    expect(result).toBe('validator_rejected');
  });
});

// --- Test 4 — escalation side effects integration ----------------------------

describe('runEscalation: side effects', () => {
  let tmpHome: string;
  const originalArchonHome = process.env.ARCHON_HOME;
  const originalNotionKey = process.env.NOTION_API_KEY;
  const originalWebhook = process.env.BUILDER_MONITOR_WEBHOOK_URL;
  const originalWorkspacePath = process.env.WORKSPACE_PATH;
  const originalArchonDocker = process.env.ARCHON_DOCKER;
  const originalHome = process.env.HOME;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'overseer-escalate-'));
    process.env.ARCHON_HOME = tmpHome;
    // Force getArchonHome to take the ARCHON_HOME branch (not the Docker branch)
    delete process.env.WORKSPACE_PATH;
    delete process.env.ARCHON_DOCKER;
    delete process.env.NOTION_API_KEY; // Notion is fail-soft; skip it in this test
    process.env.BUILDER_MONITOR_WEBHOOK_URL = 'http://test.invalid/builder-monitor';
    // Spy on global fetch so we can assert without hitting the network.
    fetchSpy = spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
  });

  afterEach(async () => {
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
    if (originalNotionKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = originalNotionKey;
    if (originalWebhook === undefined) delete process.env.BUILDER_MONITOR_WEBHOOK_URL;
    else process.env.BUILDER_MONITOR_WEBHOOK_URL = originalWebhook;
    if (originalWorkspacePath !== undefined) process.env.WORKSPACE_PATH = originalWorkspacePath;
    if (originalArchonDocker !== undefined) process.env.ARCHON_DOCKER = originalArchonDocker;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    fetchSpy.mockRestore();
    await rm(tmpHome, { recursive: true, force: true });
  });

  test('runEscalation writes escalation.json AND fires builder-monitor webhook', async () => {
    const runId = 'test-run-123';
    const context: EscalationContext = {
      errorClass: 'validator_feedback_not_applied',
      nodeId: 'commit-and-push',
      woId: 'WO-FOO-01',
      validatorOutput: 'Add lspro_token to scenario 6b',
      remediation: ['Add lspro_token to scenario 6b'],
    };
    await runEscalation(
      runId,
      {
        decision: 'escalate',
        reason: 'test reason',
        escalationContext: context,
      },
      context
    );

    // 1. escalation.json on disk
    const jsonPath = join(tmpHome, 'runs', runId, 'escalation.json');
    const fileBody = await readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(fileBody);
    expect(parsed.runId).toBe(runId);
    expect(parsed.context.errorClass).toBe('validator_feedback_not_applied');
    expect(parsed.context.woId).toBe('WO-FOO-01');
    expect(parsed.decision.reason).toBe('test reason');
    expect(typeof parsed.timestamp).toBe('string');

    // 2. builder-monitor webhook fired with action=needs_human
    const webhookCall = fetchSpy.mock.calls.find(call =>
      String(call[0]).includes('builder-monitor')
    );
    expect(webhookCall).toBeDefined();
    const init = webhookCall![1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body.action).toBe('needs_human');
    expect(body.wo_id).toBe('WO-FOO-01');
    expect(body.builder).toBe('Cauldron');
    expect(typeof body.detail).toBe('string');
    expect(body.detail).toContain('validator_feedback_not_applied');
  });

  test('runEscalation skips Notion gracefully when NOTION_API_KEY is missing (other 2 signals still fire)', async () => {
    delete process.env.NOTION_API_KEY;
    const runId = 'test-run-no-notion';
    const context: EscalationContext = {
      errorClass: 'implement_loop_no_output',
      nodeId: 'commit-and-push',
      woId: 'WO-FOO-02',
    };
    await runEscalation(
      runId,
      { decision: 'escalate', reason: 'no work produced', escalationContext: context },
      context
    );
    // escalation.json still written
    const jsonPath = join(tmpHome, 'runs', runId, 'escalation.json');
    const body = await readFile(jsonPath, 'utf8');
    expect(body).toContain('implement_loop_no_output');
    // No Notion call recorded
    const notionCall = fetchSpy.mock.calls.find(call => String(call[0]).includes('api.notion.com'));
    expect(notionCall).toBeUndefined();
  });
});

// --- Test 5 — end-to-end (incident replay) -----------------------------------

describe('end-to-end: WO-AUTH-SINGLE-PATH-E2E-04 incident replay', () => {
  let tmpHome: string;
  const originalArchonHome = process.env.ARCHON_HOME;
  const originalWebhook = process.env.BUILDER_MONITOR_WEBHOOK_URL;
  const originalWorkspacePath = process.env.WORKSPACE_PATH;
  const originalArchonDocker = process.env.ARCHON_DOCKER;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'overseer-e2e-'));
    process.env.ARCHON_HOME = tmpHome;
    delete process.env.WORKSPACE_PATH;
    delete process.env.ARCHON_DOCKER;
    delete process.env.NOTION_API_KEY;
    process.env.BUILDER_MONITOR_WEBHOOK_URL = 'http://test.invalid/builder-monitor';
    fetchSpy = spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200 })
    );
  });

  afterEach(async () => {
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
    if (originalWebhook === undefined) delete process.env.BUILDER_MONITOR_WEBHOOK_URL;
    else process.env.BUILDER_MONITOR_WEBHOOK_URL = originalWebhook;
    if (originalWorkspacePath !== undefined) process.env.WORKSPACE_PATH = originalWorkspacePath;
    if (originalArchonDocker !== undefined) process.env.ARCHON_DOCKER = originalArchonDocker;
    fetchSpy.mockRestore();
    await rm(tmpHome, { recursive: true, force: true });
  });

  test('commit-and-push stderr + validator remediation feedback => escalation fires with full context', async () => {
    // Replay the WO-AUTH-SINGLE-PATH-E2E-04 anchor incident: commit-and-push exit 1
    // with the "implement loop did not produce work" stderr, and war-council-validator
    // had emitted a specific 2-item remediation list that the agent never applied.
    const stderr =
      'No changed files and no commits ahead of origin/feat/WO-AUTH-SINGLE-PATH-E2E-04-thread-feat/WO-AUTH-SINGLE-PATH-E2E-04 -- implement loop did not produce work';
    const validatorOutput =
      "- Add lspro_token to scenario 6b's addInitScript (currently causes redirect to /login)\n" +
      '- PR body must include the local run command per stop condition 5';

    // Step 1: classify
    const errorClass = classifyError({
      message: stderr,
      nodeId: 'commit-and-push',
      nodeType: 'bash',
      exitCode: 1,
      validatorOutput,
      threadCommitsAhead: 1,
    });
    expect(errorClass).toBe('validator_feedback_not_applied');

    // Step 2: decide
    const decision = decide({
      errorClass,
      attempt: 1,
      nodeId: 'commit-and-push',
      woId: 'WO-AUTH-SINGLE-PATH-E2E-04',
      validatorOutput,
    });
    expect(decision.decision).toBe('escalate');
    expect(decision.escalationContext).toBeDefined();
    expect(decision.escalationContext?.errorClass).toBe('validator_feedback_not_applied');
    expect(decision.escalationContext?.remediation).toHaveLength(2);

    // Step 3: escalate
    const runId = 'e2e-incident-run';
    await runEscalation(runId, decision, decision.escalationContext!);

    // Step 4: verify all 3 operator-visible signals
    // (a) escalation.json on disk
    const jsonPath = join(tmpHome, 'runs', runId, 'escalation.json');
    const fileBody = await readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(fileBody);
    expect(parsed.context.errorClass).toBe('validator_feedback_not_applied');
    expect(parsed.context.woId).toBe('WO-AUTH-SINGLE-PATH-E2E-04');
    expect(parsed.context.remediation).toEqual([
      "Add lspro_token to scenario 6b's addInitScript (currently causes redirect to /login)",
      'PR body must include the local run command per stop condition 5',
    ]);

    // (b) builder-monitor webhook
    const webhookCalls = fetchSpy.mock.calls.filter(call =>
      String(call[0]).includes('builder-monitor')
    );
    expect(webhookCalls.length).toBe(1);
    const init = webhookCalls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.action).toBe('needs_human');
    expect(body.wo_id).toBe('WO-AUTH-SINGLE-PATH-E2E-04');

    // (c) Notion call skipped gracefully (no NOTION_API_KEY in this test)
    const notionCalls = fetchSpy.mock.calls.filter(call =>
      String(call[0]).includes('api.notion.com')
    );
    expect(notionCalls.length).toBe(0);
  });
});

// Reference the mock helper so bun:test doesn't drop it as unused (linter quirk).
void mock;
