/**
 * Tests for overseer-bridge.ts — the @archon/overseer wiring into dag-executor's
 * node-failure handlers.
 *
 * Per WO-HARNESS-OVERSEER-WIRE-V1-01 (bdc-xo#151), this covers each decision path
 * (escalate / skip / retry / commit_and_push_anyway) so future changes to either
 * the classifier or the bridge can't silently regress decision routing.
 */

import { describe, it, expect, mock } from 'bun:test';
import { handleNodeFailure } from './overseer-bridge.ts';
import type { WorkflowRun } from './schemas/workflow-run.ts';
import type { DagNode } from './schemas/dag-node.ts';
import type { IWorkflowStore } from './store.ts';
import type { Logger } from '@archon/paths';

// --- Minimal mocks ------------------------------------------------------------

function makeMockStore(): IWorkflowStore {
  return {
    listWorkflowRuns: mock(() => Promise.resolve([])),
    createWorkflowRun: mock(() => Promise.resolve(undefined as never)),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    updateWorkflowRunStatus: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => Promise.resolve()),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve()),
    createWorkflowEvent: mock(() => Promise.resolve()),
    getCompletedDagNodeOutputs: mock(() => Promise.resolve(new Map<string, string>())),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
  };
}

function makeMockLog(): Logger {
  const noop = () => undefined as never;
  // Cast as Logger — pino has many fields; we only exercise info/warn/error.
  return {
    info: mock(noop),
    warn: mock(noop),
    error: mock(noop),
    debug: mock(noop),
    fatal: mock(noop),
    trace: mock(noop),
    silent: mock(noop),
    child: mock(() => makeMockLog()),
    bindings: mock(() => ({})),
    level: 'info',
    levels: { values: {}, labels: {} },
  } as unknown as Logger;
}

function makeWorkflowRun(): WorkflowRun {
  return {
    id: 'test-run',
    workflow_name: 'test-wf',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'msg',
    workflow_def: {},
    skip_persona: false,
    started_at: new Date('2026-05-16T00:00:00Z').toISOString(),
    completed_at: null,
    error: null,
    metadata: null,
  } as unknown as WorkflowRun;
}

function makeNode(id = 'test-node', overrides?: Partial<DagNode>): DagNode {
  return { id, command: 'test-cmd', ...overrides } as DagNode;
}

function makeDeps() {
  const store = makeMockStore();
  const log = makeMockLog();
  const emitter = { emit: mock(() => undefined) };
  const logNodeError = mock(() => Promise.resolve());
  return { store, log, emitter, logNodeError };
}

const baseCtx = { errorMsg: '', logDir: '/tmp/test-logs', outputSoFar: '' };

// --- Tests --------------------------------------------------------------------

describe('handleNodeFailure — decision routing', () => {
  it('unknown error class -> escalate -> NodeOutput {state:failed}', async () => {
    const deps = makeDeps();
    const result = await handleNodeFailure(deps, makeWorkflowRun(), makeNode(), {
      ...baseCtx,
      errorMsg: 'something weird happened',
    });
    expect(result.decision).toBe('escalate');
    expect(result.errorClass).toBe('unknown');
    expect(result.output.state).toBe('failed');
    if (result.output.state === 'failed') {
      expect(result.output.error).toBe('something weird happened');
    }
  });

  it('out_of_credits -> escalate (v1: provider failover deferred)', async () => {
    const deps = makeDeps();
    const result = await handleNodeFailure(deps, makeWorkflowRun(), makeNode(), {
      ...baseCtx,
      errorMsg: 'credit balance is too low',
    });
    expect(result.errorClass).toBe('out_of_credits');
    expect(result.decision).toBe('escalate');
    expect(result.output.state).toBe('failed');
  });

  it('rate_limit_exceeded on attempt 1 -> retry decision -> v1 falls through to failed', async () => {
    const deps = makeDeps();
    const result = await handleNodeFailure(deps, makeWorkflowRun(), makeNode(), {
      ...baseCtx,
      errorMsg: 'rate_limit_exceeded',
      attempt: 1,
    });
    expect(result.errorClass).toBe('rate_limit_exceeded');
    expect(result.decision).toBe('retry');
    // v1 maps retry -> failed at AI-node sites (no SDK-restart path yet)
    expect(result.output.state).toBe('failed');
  });

  it('npm_not_found -> skip -> NodeOutput {state:skipped}', async () => {
    const deps = makeDeps();
    const result = await handleNodeFailure(deps, makeWorkflowRun(), makeNode(), {
      ...baseCtx,
      errorMsg: 'bash: line 3: npm: command not found',
    });
    expect(result.errorClass).toBe('npm_not_found');
    expect(result.decision).toBe('skip');
    expect(result.output.state).toBe('skipped');
  });

  it('command-style "command not found: yarn" also classifies as npm_not_found', async () => {
    const deps = makeDeps();
    const result = await handleNodeFailure(deps, makeWorkflowRun(), makeNode(), {
      ...baseCtx,
      errorMsg: 'command not found: yarn',
    });
    expect(result.errorClass).toBe('npm_not_found');
    expect(result.decision).toBe('skip');
  });

  it('sentinel_mismatch + hasOutput -> commit_and_push_anyway -> v1 falls through to failed', async () => {
    const deps = makeDeps();
    const result = await handleNodeFailure(deps, makeWorkflowRun(), makeNode('loop-node'), {
      ...baseCtx,
      errorMsg: 'SDK returned success',
      nodeType: 'loop',
      hasOutput: true,
      outputSoFar: 'partial agent output',
    });
    expect(result.errorClass).toBe('sentinel_mismatch');
    expect(result.decision).toBe('commit_and_push_anyway');
    // v1 maps commit_and_push_anyway -> failed at AI-node sites (no PR-with-note wiring yet)
    expect(result.output.state).toBe('failed');
    if (result.output.state === 'failed') {
      expect(result.output.output).toBe('partial agent output');
    }
  });

  it('verify_pre_existing -> skip', async () => {
    const deps = makeDeps();
    const result = await handleNodeFailure(deps, makeWorkflowRun(), makeNode('verify-build'), {
      ...baseCtx,
      errorMsg: 'pre-existing test failure in @archon/paths',
      exitCode: 1,
    });
    expect(result.errorClass).toBe('verify_pre_existing');
    expect(result.decision).toBe('skip');
    expect(result.output.state).toBe('skipped');
  });
});

describe('handleNodeFailure — side effects', () => {
  it('emits overseer.decision log line with structured fields', async () => {
    const deps = makeDeps();
    await handleNodeFailure(deps, makeWorkflowRun(), makeNode('node-x'), {
      ...baseCtx,
      errorMsg: 'unknown error',
    });
    const logInfo = deps.log.info as unknown as { mock: { calls: unknown[][] } };
    const overseerCall = logInfo.mock.calls.find(call => call[1] === 'overseer.decision');
    expect(overseerCall).toBeDefined();
    const fields = overseerCall![0] as Record<string, unknown>;
    expect(fields.module).toBe('overseer');
    expect(fields.runId).toBe('test-run');
    expect(fields.nodeId).toBe('node-x');
    expect(fields.errorClass).toBe('unknown');
    expect(fields.decision).toBe('escalate');
    expect(fields.reason).toBeDefined();
  });

  it('persists node_failed event with overseer_class + overseer_decision fields', async () => {
    const deps = makeDeps();
    await handleNodeFailure(deps, makeWorkflowRun(), makeNode('node-y'), {
      ...baseCtx,
      errorMsg: 'bash: line 3: npm: command not found',
    });
    const createEvent = deps.store.createWorkflowEvent as unknown as {
      mock: { calls: unknown[][] };
    };
    expect(createEvent.mock.calls.length).toBe(1);
    const payload = createEvent.mock.calls[0][0] as {
      event_type: string;
      data: Record<string, unknown>;
    };
    expect(payload.event_type).toBe('node_failed');
    expect(payload.data.overseer_class).toBe('npm_not_found');
    expect(payload.data.overseer_decision).toBe('skip');
    expect(payload.data.error).toBe('bash: line 3: npm: command not found');
  });

  it('emits node_failed event on the workflow emitter', async () => {
    const deps = makeDeps();
    await handleNodeFailure(deps, makeWorkflowRun(), makeNode('node-z'), {
      ...baseCtx,
      errorMsg: 'whatever',
    });
    const emit = deps.emitter.emit as unknown as { mock: { calls: unknown[][] } };
    expect(emit.mock.calls.length).toBe(1);
    const event = emit.mock.calls[0][0] as { type: string; nodeId: string };
    expect(event.type).toBe('node_failed');
    expect(event.nodeId).toBe('node-z');
  });

  it('calls logNodeError with the failure message', async () => {
    const deps = makeDeps();
    await handleNodeFailure(deps, makeWorkflowRun(), makeNode(), {
      ...baseCtx,
      errorMsg: 'specific error',
      logDir: '/var/log/test',
    });
    const lne = deps.logNodeError as unknown as { mock: { calls: unknown[][] } };
    expect(lne.mock.calls.length).toBe(1);
    expect(lne.mock.calls[0]).toEqual(['/var/log/test', 'test-run', 'test-node', 'specific error']);
  });

  it('passes outputSoFar through to NodeOutput.output', async () => {
    const deps = makeDeps();
    const result = await handleNodeFailure(deps, makeWorkflowRun(), makeNode(), {
      ...baseCtx,
      errorMsg: 'cancelled',
      outputSoFar: 'partial response so far',
    });
    expect(result.output.output).toBe('partial response so far');
  });
});
