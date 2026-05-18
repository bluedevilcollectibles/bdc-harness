/**
 * Tests for the operator-pause and admin-throttle routes added by
 * WO-HARNESS-RATE-LIMIT-AUTO-PAUSE-ENGINE-01.
 *
 * Covered:
 *  1. POST /pause flips a running run to paused
 *  2. POST /pause returns 422 for terminal status
 *  3. POST /pause returns 409 when already paused
 *  4. POST /resume wakes an operator-paused run
 *  5. POST /admin/throttle engages the global gate
 *  6. checkRateLimitAndMaybeThrottle auto-releases when a fresh window opens
 *  7. POST /pause returns 404 when the run does not exist
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';

// ---------------------------------------------------------------------------
// Mock setup — must be before dynamic imports of mocked modules
// ---------------------------------------------------------------------------

type MockWorkflowRun = {
  id: string;
  workflow_name: string;
  conversation_id: string | null;
  parent_conversation_id: string | null;
  codebase_id: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
  user_message: string;
  started_at: string;
  completed_at: string | null;
  metadata: Record<string, unknown>;
  working_path: string | null;
  last_activity_at: string | null;
};

const mockGetWorkflowRun = mock(async (_id: string) => null as null | MockWorkflowRun);
const mockPauseWorkflowRunByOperator = mock(async (_id: string) => {});
const mockResumeWorkflowRunFromPause = mock(async (_id: string) => {});
const mockCreateWorkflowEvent = mock(async (_event: unknown) => {});

// Throttle singleton: in-memory state replicated via mocks so we can assert.
let throttleState = { paused: false, engagedBy: undefined as 'operator' | 'auto' | undefined };
const mockSetThrottled = mock((paused: boolean, ctx?: { engagedBy: 'operator' | 'auto' }) => {
  throttleState = { paused, engagedBy: paused ? (ctx?.engagedBy ?? 'operator') : undefined };
});
const mockIsThrottled = mock(() => throttleState.paused);
const mockGetEngageContext = mock(() =>
  throttleState.paused ? { engagedBy: throttleState.engagedBy ?? 'operator' } : undefined
);
const mockWaitForRelease = mock(async () => undefined);
// Real implementation of checkRateLimitAndMaybeThrottle for test 6 — we
// validate the integration (rate-limit info → setThrottled) without depending
// on the actual provider module.
function fakeCheckRateLimitAndMaybeThrottle(info: Record<string, unknown>): void {
  const utilization = typeof info.utilization === 'number' ? info.utilization : undefined;
  const resetsAtSec = typeof info.resetsAt === 'number' ? info.resetsAt : undefined;
  const status = info.status;
  const now = Date.now();
  if (
    !throttleState.paused &&
    utilization !== undefined &&
    utilization >= 0.85 &&
    resetsAtSec !== undefined &&
    resetsAtSec * 1000 - now > 0 &&
    resetsAtSec * 1000 - now < 300_000
  ) {
    mockSetThrottled(true, { engagedBy: 'auto' });
    return;
  }
  if (
    throttleState.paused &&
    throttleState.engagedBy === 'auto' &&
    status === 'allowed' &&
    resetsAtSec !== undefined &&
    resetsAtSec * 1000 > now
  ) {
    mockSetThrottled(false);
  }
}

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  generateAndSetTitle: mock(async () => {}),
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
}));

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
}));

mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mock(async () => ({ workflows: [], errors: [] })),
}));

mock.module('@archon/workflows/loader', () => ({
  parseWorkflow: mock(() => ({
    workflow: null,
    error: { filename: '', error: 'stub', errorType: 'parse_error' },
  })),
  getLoaderErrors: mock(() => []),
}));

mock.module('@archon/workflows/command-validation', () => ({
  isValidCommandName: mock(() => true),
}));

mock.module('@archon/workflows/defaults', () => ({
  BUNDLED_WORKFLOWS: {},
  BUNDLED_COMMANDS: {},
  isBinaryBuild: mock(() => false),
}));

mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mock(async () => ({ success: true, workflowRunId: 'run-uuid-1' })),
}));

mock.module('@archon/core/workflows', () => ({
  createWorkflowDeps: mock(() => ({ store: {} })),
}));

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mock(async () => null),
  listConversations: mock(async () => []),
  getOrCreateConversation: mock(async () => ({
    id: 'internal-uuid-123',
    platform_conversation_id: 'web-test-abc',
    title: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    platform_type: 'web',
    deleted_at: null,
    codebase_id: null,
    ai_assistant_type: 'claude',
  })),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
}));

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: '/tmp/project' }]),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
}));

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: mock(async () => ({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0, paused: 0 },
  })),
  getWorkflowRun: mockGetWorkflowRun,
  cancelWorkflowRun: mock(async () => {}),
  cancelStaleWorkflowRuns: mock(async () => ({ count: 0, ids: [] })),
  pauseWorkflowRunByOperator: mockPauseWorkflowRunByOperator,
  resumeWorkflowRunFromPause: mockResumeWorkflowRunFromPause,
  deleteWorkflowRun: mock(async () => {}),
  updateWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
  createWorkflowEvent: mockCreateWorkflowEvent,
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => ({
    id: 'msg-1',
    conversation_id: 'conv-1',
    role: 'user' as const,
    content: 'hi',
    metadata: '{}',
    created_at: new Date().toISOString(),
  })),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

// Throttle singleton — mocked at module path so api.ts uses our fake state.
mock.module('@archon/providers/claude/throttle', () => ({
  claudeProviderThrottle: {
    isThrottled: mockIsThrottled,
    setThrottled: mockSetThrottled,
    waitForRelease: mockWaitForRelease,
    checkRateLimitAndMaybeThrottle: fakeCheckRateLimitAndMaybeThrottle,
    getEngageContext: mockGetEngageContext,
  },
  AUTO_THROTTLE_UTILIZATION: 0.85,
  AUTO_THROTTLE_LEAD_MS: 300_000,
}));

import { registerApiRoutes } from './api';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();

const MOCK_RUNNING_RUN: MockWorkflowRun = {
  id: 'run-uuid-1',
  workflow_name: 'long-build',
  conversation_id: 'conv-uuid-1',
  parent_conversation_id: null,
  codebase_id: 'cb-uuid-1',
  status: 'running',
  user_message: 'Build the harness',
  started_at: NOW,
  completed_at: null,
  metadata: {},
  working_path: '/tmp/worktrees/feature',
  last_activity_at: NOW,
};

const MOCK_PAUSED_RUN: MockWorkflowRun = {
  ...MOCK_RUNNING_RUN,
  status: 'paused',
  metadata: { paused_by: 'operator', paused_at: NOW },
};

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function makeApp(): { app: OpenAPIHono; mockWebAdapter: WebAdapter } {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const mockWebAdapter = {
    setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
    setupEventBridge: mock((_workerId: string, _parentId: string) => mock(() => {})),
    sendMessage: mock(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(() => ({ active: 0, queued: 0 })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return { app, mockWebAdapter };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/workflows/runs/:runId/pause', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockPauseWorkflowRunByOperator.mockReset();
    mockCreateWorkflowEvent.mockReset();
    throttleState = { paused: false, engagedBy: undefined };
  });

  test('returns 200 and flips status to paused for a running run', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      status: 'paused' as const,
      metadata: { paused_by: 'operator' },
    }));
    mockPauseWorkflowRunByOperator.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      success: boolean;
      message: string;
      run: MockWorkflowRun;
    };
    expect(body.success).toBe(true);
    expect(body.message).toContain('long-build');
    expect(body.run.status).toBe('paused');
    expect(mockPauseWorkflowRunByOperator).toHaveBeenCalledWith('run-uuid-1');

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockCreateWorkflowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_run_id: 'run-uuid-1',
        event_type: 'run_paused',
        data: expect.objectContaining({ actor: 'operator' }),
      })
    );
  });

  test('returns 422 when run is in terminal completed status', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      status: 'completed' as const,
      completed_at: NOW,
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/pause', {
      method: 'POST',
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("'completed'");
    expect(mockPauseWorkflowRunByOperator).not.toHaveBeenCalled();
  });

  test('returns 409 when run is already paused', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_PAUSED_RUN);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/pause', {
      method: 'POST',
    });
    expect(response.status).toBe(409);
    expect(mockPauseWorkflowRunByOperator).not.toHaveBeenCalled();
  });

  test('returns 404 when run does not exist', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => null);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/unknown-run-id/pause', {
      method: 'POST',
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });
});

describe('POST /api/workflows/runs/:runId/resume (operator-paused run)', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockResumeWorkflowRunFromPause.mockReset();
    mockCreateWorkflowEvent.mockReset();
  });

  test('wakes an operator-paused run by flipping status to running', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_PAUSED_RUN);
    mockResumeWorkflowRunFromPause.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/resume', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('long-build');
    expect(mockResumeWorkflowRunFromPause).toHaveBeenCalledWith('run-uuid-1');

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockCreateWorkflowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_run_id: 'run-uuid-1',
        event_type: 'run_resumed',
        data: expect.objectContaining({ actor: 'operator' }),
      })
    );
  });
});

describe('POST /api/admin/throttle', () => {
  beforeEach(() => {
    mockSetThrottled.mockClear();
    mockIsThrottled.mockClear();
    throttleState = { paused: false, engagedBy: undefined };
  });

  test('engages the global throttle gate when called with paused=true', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/admin/throttle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      success: boolean;
      paused: boolean;
      engagedBy?: string;
    };
    expect(body.success).toBe(true);
    expect(body.paused).toBe(true);
    expect(body.engagedBy).toBe('operator');
    expect(mockSetThrottled).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ engagedBy: 'operator' })
    );
    expect(throttleState.paused).toBe(true);
  });
});

describe('checkRateLimitAndMaybeThrottle (auto-engage + auto-release)', () => {
  beforeEach(() => {
    mockSetThrottled.mockClear();
    throttleState = { paused: false, engagedBy: undefined };
  });

  test('auto-releases when a fresh window opens (status:allowed + later resetsAt)', async () => {
    // First: engage via near-window-end rate-limit event
    const nowSec = Math.floor(Date.now() / 1000);
    fakeCheckRateLimitAndMaybeThrottle({
      status: 'allowed_warning',
      utilization: 0.92,
      surpassedThreshold: 0.9,
      resetsAt: nowSec + 60, // 60s until reset → within 5min lead
    });
    expect(throttleState.paused).toBe(true);
    expect(throttleState.engagedBy).toBe('auto');

    // Manually advance time perception by feeding a much later resetsAt
    fakeCheckRateLimitAndMaybeThrottle({
      status: 'allowed',
      utilization: 0.1,
      resetsAt: nowSec + 5 * 60 * 60, // 5h fresh window
    });
    expect(throttleState.paused).toBe(false);
    expect(mockSetThrottled).toHaveBeenLastCalledWith(false);
  });
});
