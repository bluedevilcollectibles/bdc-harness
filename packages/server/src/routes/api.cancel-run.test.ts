import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';

// ---------------------------------------------------------------------------
// Mock setup — must be before dynamic imports of mocked modules
// ---------------------------------------------------------------------------

const mockGetWorkflowRun = mock(async (_id: string) => null as null | MockWorkflowRun);
const mockCancelWorkflowRun = mock(async (_id: string) => {});
const mockCancelStaleWorkflowRuns = mock(async (_minutes: number) => ({
  count: 0,
  ids: [] as string[],
}));

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

const mockCreateWorkflowEvent = mock(async (_event: unknown) => {});

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
  cancelWorkflowRun: mockCancelWorkflowRun,
  cancelStaleWorkflowRuns: mockCancelStaleWorkflowRuns,
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

import { registerApiRoutes } from './api';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();

const MOCK_RUNNING_RUN: MockWorkflowRun = {
  id: 'run-uuid-1',
  workflow_name: 'deploy',
  conversation_id: 'conv-uuid-1',
  parent_conversation_id: null,
  codebase_id: 'cb-uuid-1',
  status: 'running',
  user_message: 'Deploy to staging',
  started_at: NOW,
  completed_at: null,
  metadata: {},
  working_path: '/tmp/worktrees/feature',
  last_activity_at: NOW,
};

const MOCK_CANCELLED_RUN: MockWorkflowRun = {
  ...MOCK_RUNNING_RUN,
  id: 'run-uuid-5',
  status: 'cancelled',
  completed_at: NOW,
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
// Tests: POST /api/workflows/runs/:runId/cancel
// ---------------------------------------------------------------------------

describe('POST /api/workflows/runs/:runId/cancel', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockCancelWorkflowRun.mockReset();
    mockCreateWorkflowEvent.mockReset();
  });

  test('returns 200 and flips status to cancelled for a running run', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    const cancelledRun = { ...MOCK_RUNNING_RUN, status: 'cancelled' as const, completed_at: NOW };
    mockGetWorkflowRun.mockImplementationOnce(async () => cancelledRun);
    mockCancelWorkflowRun.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
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
    expect(body.message).toContain('deploy');
    expect(body.run.status).toBe('cancelled');
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-uuid-1');
  });

  test('captures reason in run_cancelled event', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      status: 'cancelled' as const,
    }));
    mockCancelWorkflowRun.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'zombie cleanup' }),
    });

    // Allow fire-and-forget event to flush
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockCreateWorkflowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_run_id: 'run-uuid-1',
        event_type: 'run_cancelled',
        data: expect.objectContaining({ reason: 'zombie cleanup' }),
      })
    );
  });

  test('writes run_cancelled event even when reason is omitted', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      status: 'cancelled' as const,
    }));
    mockCancelWorkflowRun.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    await app.request('/api/workflows/runs/run-uuid-1/cancel', { method: 'POST' });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockCreateWorkflowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'run_cancelled',
        workflow_run_id: 'run-uuid-1',
      })
    );
  });

  test('returns updated run row in response body', async () => {
    const cancelledRun = { ...MOCK_RUNNING_RUN, status: 'cancelled' as const, completed_at: NOW };
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    mockGetWorkflowRun.mockImplementationOnce(async () => cancelledRun);
    mockCancelWorkflowRun.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });
    const body = (await response.json()) as { run: MockWorkflowRun };
    expect(body.run.id).toBe('run-uuid-1');
    expect(body.run.status).toBe('cancelled');
  });

  test('returns 409 when run is already cancelled', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_CANCELLED_RUN);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-5/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(409);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('cancelled');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('returns 422 when run is completed', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      status: 'completed' as const,
      completed_at: NOW,
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(422);
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('returns 422 when run is failed', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      status: 'failed' as const,
      completed_at: NOW,
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(422);
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('returns 404 when run does not exist', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => null);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/unknown-run-id/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('returns 200 and cancels a paused run', async () => {
    const pausedRun = { ...MOCK_RUNNING_RUN, status: 'paused' as const };
    mockGetWorkflowRun.mockImplementationOnce(async () => pausedRun);
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...pausedRun,
      status: 'cancelled' as const,
    }));
    mockCancelWorkflowRun.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(mockCancelWorkflowRun).toHaveBeenCalled();
  });

  test('returns 500 when DB throws during cancel', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    mockCancelWorkflowRun.mockImplementationOnce(async () => {
      throw new Error('DB locked');
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to cancel');
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/runs/cancel-stale
// ---------------------------------------------------------------------------

describe('POST /api/workflows/runs/cancel-stale', () => {
  beforeEach(() => {
    mockCancelStaleWorkflowRuns.mockReset();
    mockCreateWorkflowEvent.mockReset();
  });

  test('returns 200 with count and ids when stale runs exist', async () => {
    mockCancelStaleWorkflowRuns.mockImplementationOnce(async () => ({
      count: 2,
      ids: ['stale-run-1', 'stale-run-2'],
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/cancel-stale', {
      method: 'POST',
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { cancelled: number; runIds: string[] };
    expect(body.cancelled).toBe(2);
    expect(body.runIds).toEqual(['stale-run-1', 'stale-run-2']);
  });

  test('returns 200 with count 0 when no stale runs', async () => {
    mockCancelStaleWorkflowRuns.mockImplementationOnce(async () => ({ count: 0, ids: [] }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/cancel-stale', {
      method: 'POST',
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { cancelled: number; runIds: string[] };
    expect(body.cancelled).toBe(0);
    expect(body.runIds).toHaveLength(0);
  });

  test('writes run_cancelled event for each stale run', async () => {
    mockCancelStaleWorkflowRuns.mockImplementationOnce(async () => ({
      count: 2,
      ids: ['stale-run-1', 'stale-run-2'],
    }));

    const { app } = makeApp();
    await app.request('/api/workflows/runs/cancel-stale', { method: 'POST' });

    // Allow fire-and-forget events to flush
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockCreateWorkflowEvent).toHaveBeenCalledTimes(2);
    expect(mockCreateWorkflowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_run_id: 'stale-run-1',
        event_type: 'run_cancelled',
      })
    );
    expect(mockCreateWorkflowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_run_id: 'stale-run-2',
        event_type: 'run_cancelled',
      })
    );
  });

  test('does not write events when no stale runs cancelled', async () => {
    mockCancelStaleWorkflowRuns.mockImplementationOnce(async () => ({ count: 0, ids: [] }));

    const { app } = makeApp();
    await app.request('/api/workflows/runs/cancel-stale', { method: 'POST' });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
  });

  test('returns 500 when DB throws', async () => {
    mockCancelStaleWorkflowRuns.mockImplementationOnce(async () => {
      throw new Error('DB connection lost');
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/cancel-stale', {
      method: 'POST',
    });
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to cancel stale');
  });
});
