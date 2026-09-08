import { describe, test, expect, mock } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import {
  mockAllWorkflowModules,
  mockDiscoverWorkflowsWithConfig,
} from '../test/workflow-mock-factories';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';

// The operator-token gate in registerApiRoutes() activates whenever
// ARCHON_OPERATOR_TOKEN is set. Clear it at module level so these tests run
// deterministically in container envs (Cauldron build image exports this var).
delete process.env.ARCHON_OPERATOR_TOKEN;
delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
delete process.env.ARCHON_OPERATOR_EMAILS;

const mockFindConversationByPlatformId = mock(
  async (_platformId: string) =>
    null as null | {
      id: string;
      platform_conversation_id: string;
      title: string | null;
      created_at: Date;
      updated_at: Date;
      platform_type: string;
      deleted_at: Date | null;
      codebase_id: string | null;
    }
);
const mockSoftDeleteConversation = mock(async (_id: string) => {});
const mockUpdateConversationTitle = mock(async (_id: string, _title: string) => {});

const mockGenerateAndSetTitle = mock(async () => {});
const mockHandleMessage = mock(async (..._args: unknown[]) => {});
mock.module('@archon/core', () => ({
  handleMessage: mockHandleMessage,
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands', '.archon/commands/defaults']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  cloneRepository: mock(async () => {}),
  registerRepository: mock(async () => ({ success: true })),
  removeWorktree: mock(async () => ({ success: true })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  generateAndSetTitle: mockGenerateAndSetTitle,
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
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

mockAllWorkflowModules();

const mockGetOrCreateConversation = mock(
  async (_platform?: string, _platformId?: string, _codebaseId?: string | null) => ({
    id: 'internal-uuid-123',
    platform_conversation_id: 'web-test-abc',
    title: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    platform_type: 'web',
    deleted_at: null,
    codebase_id: null,
  })
);
mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mockFindConversationByPlatformId,
  softDeleteConversation: mockSoftDeleteConversation,
  updateConversationTitle: mockUpdateConversationTitle,
  listConversations: mock(async () => []),
  getOrCreateConversation: mockGetOrCreateConversation,
}));

mock.module('@archon/core/db/isolation-environments', () => ({}));
mock.module('@archon/core/db/workflows', () => ({}));
mock.module('@archon/core/db/workflow-events', () => ({}));
const mockAddMessage = mock(async (_convId: string, _role: string, _content: string) => ({
  id: 'msg-uuid-1',
}));
mock.module('@archon/core/db/messages', () => ({
  addMessage: mockAddMessage,
}));
mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: '/tmp/project' }]),
  getCodebase: mock(async () => null),
}));

import { registerApiRoutes } from './api';

const MOCK_CONV = {
  id: 'internal-uuid-123',
  platform_conversation_id: 'web-test-abc',
  title: null,
  created_at: new Date(),
  updated_at: new Date(),
  platform_type: 'web',
  deleted_at: null,
  codebase_id: null,
};

describe('GET /api/conversations/:id', () => {
  test('returns conversation JSON by platform conversation ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { platform_conversation_id: string };
    expect(body.platform_conversation_id).toBe('web-test-abc');
  });

  test('returns 404 for unknown platform conversation ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-nonexistent-id');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('returns 500 when DB throws unexpectedly', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => {
      throw new Error('DB connection lost');
    });

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc');
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to get conversation');
  });
});

describe('DELETE /api/conversations/:id', () => {
  test('returns { success: true } when deleting by platform conversation ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockSoftDeleteConversation.mockImplementationOnce(async () => {});

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc', { method: 'DELETE' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body).toEqual({ success: true });
    expect(mockSoftDeleteConversation).toHaveBeenCalledWith('internal-uuid-123');
  });

  test('returns 404 when platform conversation ID does not exist', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-nonexistent-id', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });
});

describe('PATCH /api/conversations/:id', () => {
  test('resolves platform ID and updates title using internal ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockUpdateConversationTitle.mockImplementationOnce(async () => {});

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Title' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body).toEqual({ success: true });
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith('internal-uuid-123', 'New Title');
  });

  test('returns 404 when platform conversation ID does not exist', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-nonexistent-id', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Title' }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('returns 400 for malformed JSON body', async () => {
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json{',
    });
    expect(response.status).toBe(400);
  });

  test('returns { success: true } without calling updateConversationTitle when body has no title', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const callsBefore = mockUpdateConversationTitle.mock.calls.length;
    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body).toEqual({ success: true });
    expect(mockUpdateConversationTitle.mock.calls.length).toBe(callsBefore);
  });

  test('truncates title to 255 characters', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockUpdateConversationTitle.mockImplementationOnce(async () => {});

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const longTitle = 'a'.repeat(300);
    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: longTitle }),
    });
    expect(response.status).toBe(200);
    const lastCall = mockUpdateConversationTitle.mock.calls.at(-1) as [string, string];
    expect(lastCall[1].length).toBe(255);
  });
});

describe('POST /api/conversations', () => {
  const mockWebAdapter = {
    setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
  } as unknown as WebAdapter;

  test('creates conversation and returns auto-generated conversationId', async () => {
    const app = new OpenAPIHono();
    registerApiRoutes(app, mockWebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { conversationId: string; id: string };
    expect(body.conversationId).toBe('web-test-abc');
    expect(body.id).toBe('internal-uuid-123');
  });

  test('returns 400 if conversationId is provided in request body', async () => {
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'my-custom-id' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('conversationId');
  });

  test('returns 400 for malformed JSON body', async () => {
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json{',
    });
    expect(response.status).toBe(400);
  });
});

describe('POST /api/conversations with message (atomic create+send)', () => {
  const mockLockManager = {
    acquireLock: mock(async (_convId: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' as const };
    }),
  } as unknown as ConversationLockManager;

  const mockWebAdapter = {
    setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
    emitLockEvent: mock((_convId: string, _locked: boolean) => {}),
    emitSSE: mock(async (_convId: string, _data: string) => {}),
  } as unknown as WebAdapter;

  test('creates conversation and dispatches message atomically', async () => {
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, mockLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      conversationId: string;
      id: string;
      dispatched: boolean;
    };
    expect(body.conversationId).toBe('web-test-abc');
    expect(body.id).toBe('internal-uuid-123');
    expect(body.dispatched).toBe(true);
  });

  test('persists user message during atomic creation', async () => {
    const callsBefore = mockAddMessage.mock.calls.length;

    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, mockLockManager);

    await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test message' }),
    });
    expect(mockAddMessage.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  test('generates title for non-command messages', async () => {
    const callsBefore = mockGenerateAndSetTitle.mock.calls.length;

    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, mockLockManager);

    await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'help me debug this function' }),
    });
    expect(mockGenerateAndSetTitle.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  test('skips title generation for slash commands', async () => {
    const callsBefore = mockGenerateAndSetTitle.mock.calls.length;

    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, mockLockManager);

    await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '/status' }),
    });
    expect(mockGenerateAndSetTitle.mock.calls.length).toBe(callsBefore);
  });

  test('still works without message (backward compatible)', async () => {
    const simpleWebAdapter = {
      setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
    } as unknown as WebAdapter;

    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, simpleWebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      conversationId: string;
      id: string;
      dispatched?: boolean;
    };
    expect(body.conversationId).toBe('web-test-abc');
    expect(body.id).toBe('internal-uuid-123');
    expect(body.dispatched).toBeUndefined();
  });

  // Regression: 2026-07-07 false-dispatch incident. Dispatching a retired /
  // nonexistent workflow via the atomic create+send path returned
  // {dispatched:true, accepted:true} and the failure only landed as an
  // assistant message inside the conversation -- fire.ps1 reported "run
  // started" twice for a lane that could never run. The dispatch endpoint
  // must validate the workflow name BEFORE accepting.
  describe('workflow-run pre-dispatch validation', () => {
    const makeWorkflow = (name: string): WorkflowDefinition =>
      ({ name, description: 'test', nodes: [{ id: 'n', prompt: 'p' }] }) as WorkflowDefinition;

    test('rejects /workflow run for a nonexistent workflow with accepted:false (no dispatch)', async () => {
      // Discovery mock returns [] by default -- no workflow can resolve.
      const acquireLock = mock(async (_convId: string, fn: () => Promise<void>) => {
        await fn();
        return { status: 'started' as const };
      });
      const app = new OpenAPIHono({ defaultHook: validationErrorHook });
      registerApiRoutes(app, mockWebAdapter, {
        acquireLock,
      } as unknown as ConversationLockManager);

      const response = await app.request('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: '/workflow run bdc-feature-development-fusion-cx-qwen WO_ID=WO-TEST-01',
        }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        accepted: boolean;
        dispatched: boolean;
        error: string;
      };
      expect(body.accepted).toBe(false);
      expect(body.dispatched).toBe(false);
      expect(body.error).toContain('bdc-feature-development-fusion-cx-qwen');
      // The orchestrator must never have been invoked.
      expect(acquireLock.mock.calls.length).toBe(0);
    });

    test('accepts /workflow run when the workflow resolves', async () => {
      mockDiscoverWorkflowsWithConfig.mockImplementationOnce(async () => ({
        workflows: [
          { workflow: makeWorkflow('bdc-feature-development'), source: 'project' as const },
        ],
        errors: [],
      }));

      const app = new OpenAPIHono({ defaultHook: validationErrorHook });
      registerApiRoutes(app, mockWebAdapter, mockLockManager);

      const response = await app.request('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: '/workflow run bdc-feature-development WO_ID=WO-TEST-01',
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { dispatched: boolean };
      expect(body.dispatched).toBe(true);
    });

    test('non-workflow messages are not affected by validation', async () => {
      const app = new OpenAPIHono({ defaultHook: validationErrorHook });
      registerApiRoutes(app, mockWebAdapter, mockLockManager);

      const response = await app.request('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'plain chat message' }),
      });
      expect(response.status).toBe(200);
    });
  });

  // WO-HARNESS-ATOMIC-FIRE-FROM-BRANCH-01: atomic --from origin/<branch> override.
  describe('--from branch override (atomic fire)', () => {
    const makeWorkflow = (name: string, extra?: Partial<WorkflowDefinition>): WorkflowDefinition =>
      ({
        name,
        description: 'test',
        nodes: [{ id: 'n', prompt: 'p' }],
        ...extra,
      }) as WorkflowDefinition;

    const resolvingDiscovery = (wf: WorkflowDefinition) => {
      mockDiscoverWorkflowsWithConfig.mockImplementationOnce(async () => ({
        workflows: [{ workflow: wf, source: 'project' as const }],
        errors: [],
      }));
    };

    const post = async (message: string, lock?: ConversationLockManager) => {
      const app = new OpenAPIHono({ defaultHook: validationErrorHook });
      registerApiRoutes(app, mockWebAdapter, lock ?? mockLockManager);
      return app.request('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
    };

    test('valid --from origin/release/ce dispatches task hints to handleMessage', async () => {
      resolvingDiscovery(makeWorkflow('bdc-feature-development'));
      mockHandleMessage.mockClear();

      const response = await post(
        '/workflow run bdc-feature-development WO_ID=WO-X --from origin/release/ce'
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { dispatched: boolean };
      expect(body.dispatched).toBe(true);

      const ctxArg = mockHandleMessage.mock.calls.at(-1)?.[3] as
        | { isolationHints?: Record<string, unknown> }
        | undefined;
      expect(ctxArg?.isolationHints?.workflowType).toBe('task');
      expect(ctxArg?.isolationHints?.fromBranch).toBe('origin/release/ce');
      // workflowId keyed to the conversation at this layer (worker id assigned later).
      expect(ctxArg?.isolationHints?.workflowId).toBe('web-test-abc');
    });

    test('alias --from-branch behaves identically', async () => {
      resolvingDiscovery(makeWorkflow('bdc-feature-development'));
      mockHandleMessage.mockClear();

      const response = await post(
        '/workflow run bdc-feature-development WO_ID=WO-X --from-branch origin/release/ce'
      );
      expect(response.status).toBe(200);
      const ctxArg = mockHandleMessage.mock.calls.at(-1)?.[3] as
        | { isolationHints?: Record<string, unknown> }
        | undefined;
      expect(ctxArg?.isolationHints?.workflowType).toBe('task');
      expect(ctxArg?.isolationHints?.fromBranch).toBe('origin/release/ce');
    });

    test('no --from preserves thread isolation (regression)', async () => {
      resolvingDiscovery(makeWorkflow('bdc-feature-development'));
      mockHandleMessage.mockClear();

      await post('/workflow run bdc-feature-development WO_ID=WO-X');
      const ctxArg = mockHandleMessage.mock.calls.at(-1)?.[3] as
        | { isolationHints?: Record<string, unknown> }
        | undefined;
      expect(ctxArg?.isolationHints?.workflowType).toBe('thread');
      expect(ctxArg?.isolationHints?.fromBranch).toBeUndefined();
    });

    test('discovery failure with --from fails closed before conversation creation', async () => {
      mockDiscoverWorkflowsWithConfig.mockImplementationOnce(async () => {
        throw new Error('workflow discovery unavailable');
      });
      mockGetOrCreateConversation.mockClear();
      mockAddMessage.mockClear();
      mockHandleMessage.mockClear();
      const acquireLock = mock(async (_c: string, fn: () => Promise<void>) => {
        await fn();
        return { status: 'started' as const };
      });

      const response = await post(
        '/workflow run bdc-feature-development WO_ID=WO-X --from origin/release/ce',
        { acquireLock } as unknown as ConversationLockManager
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        accepted: boolean;
        dispatched: boolean;
        error: string;
      };
      expect(body.accepted).toBe(false);
      expect(body.dispatched).toBe(false);
      expect(body.error).toContain('Workflow discovery');
      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(0);
      expect(mockAddMessage).toHaveBeenCalledTimes(0);
      expect(mockHandleMessage).toHaveBeenCalledTimes(0);
      expect(acquireLock).toHaveBeenCalledTimes(0);
    });

    test('discovery failure without --from preserves graceful dispatch behavior', async () => {
      mockDiscoverWorkflowsWithConfig.mockImplementationOnce(async () => {
        throw new Error('workflow discovery unavailable');
      });
      mockGetOrCreateConversation.mockClear();
      mockHandleMessage.mockClear();

      const response = await post('/workflow run bdc-feature-development WO_ID=WO-X');

      expect(response.status).toBe(200);
      const body = (await response.json()) as { dispatched: boolean };
      expect(body.dispatched).toBe(true);
      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(1);
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    });

    test('non-origin value (bare release/ce) rejected 400 before conversation creation', async () => {
      mockGetOrCreateConversation.mockClear();
      mockAddMessage.mockClear();
      const acquireLock = mock(async (_c: string, fn: () => Promise<void>) => {
        await fn();
        return { status: 'started' as const };
      });

      const response = await post(
        '/workflow run bdc-feature-development WO_ID=WO-X --from release/ce',
        { acquireLock } as unknown as ConversationLockManager
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { accepted: boolean; dispatched: boolean };
      expect(body.accepted).toBe(false);
      expect(body.dispatched).toBe(false);
      expect(mockGetOrCreateConversation.mock.calls.length).toBe(0);
      expect(mockAddMessage.mock.calls.length).toBe(0);
      expect(acquireLock.mock.calls.length).toBe(0);
    });

    test('missing --from value rejected 400', async () => {
      const response = await post('/workflow run bdc-feature-development WO_ID=WO-X --from');
      expect(response.status).toBe(400);
    });

    test('duplicate --from flags rejected 400', async () => {
      const response = await post(
        '/workflow run bdc-feature-development --from origin/release/ce --from origin/main'
      );
      expect(response.status).toBe(400);
    });

    test('mixed --from/--from-branch flags rejected 400', async () => {
      const response = await post(
        '/workflow run bdc-feature-development --from origin/release/ce --from-branch origin/main'
      );
      expect(response.status).toBe(400);
    });

    test('option-like value rejected 400', async () => {
      const response = await post(
        '/workflow run bdc-feature-development --from=-origin/release/ce'
      );
      expect(response.status).toBe(400);
    });

    test('invalid git ref (dot-dot) rejected 400', async () => {
      const response = await post('/workflow run bdc-feature-development --from origin/foo..bar');
      expect(response.status).toBe(400);
    });

    test('worktree.enabled:false workflow with valid --from rejected 400, no conversation', async () => {
      resolvingDiscovery(makeWorkflow('read-only-triage', { worktree: { enabled: false } }));
      mockGetOrCreateConversation.mockClear();
      mockAddMessage.mockClear();
      mockHandleMessage.mockClear();
      const acquireLock = mock(async (_c: string, fn: () => Promise<void>) => {
        await fn();
        return { status: 'started' as const };
      });

      const response = await post('/workflow run read-only-triage --from origin/release/ce', {
        acquireLock,
      } as unknown as ConversationLockManager);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { accepted: boolean; dispatched: boolean };
      expect(body.accepted).toBe(false);
      expect(body.dispatched).toBe(false);
      // The API boundary rejects before any workflow dispatch. Therefore no
      // conversation/worker, workflow-run path, or isolation path is reachable.
      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(0);
      expect(mockAddMessage).toHaveBeenCalledTimes(0);
      expect(mockHandleMessage).toHaveBeenCalledTimes(0);
      expect(acquireLock).toHaveBeenCalledTimes(0);
    });

    test('two valid fires get independent conversation-keyed hints (idempotency)', async () => {
      resolvingDiscovery(makeWorkflow('bdc-feature-development'));
      mockHandleMessage.mockClear();
      mockGetOrCreateConversation.mockImplementationOnce(async (_platform, platformId) => ({
        id: 'internal-uuid-fire-a',
        platform_conversation_id: platformId ?? 'missing-fire-a',
        title: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        platform_type: 'web',
        deleted_at: null,
        codebase_id: null,
      }));
      await post('/workflow run bdc-feature-development WO_ID=WO-A --from origin/release/ce');
      const first = mockHandleMessage.mock.calls.at(-1)?.[3] as {
        isolationHints?: Record<string, unknown>;
      };

      resolvingDiscovery(makeWorkflow('bdc-feature-development'));
      mockGetOrCreateConversation.mockImplementationOnce(async (_platform, platformId) => ({
        id: 'internal-uuid-fire-b',
        platform_conversation_id: platformId ?? 'missing-fire-b',
        title: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        platform_type: 'web',
        deleted_at: null,
        codebase_id: null,
      }));
      await post('/workflow run bdc-feature-development WO_ID=WO-B --from origin/release/ce');
      const second = mockHandleMessage.mock.calls.at(-1)?.[3] as {
        isolationHints?: Record<string, unknown>;
      };

      expect(first?.isolationHints?.fromBranch).toBe('origin/release/ce');
      expect(second?.isolationHints?.fromBranch).toBe('origin/release/ce');
      expect(first?.isolationHints?.workflowType).toBe('task');
      expect(second?.isolationHints?.workflowType).toBe('task');
      expect(first?.isolationHints?.workflowId).not.toBe(second?.isolationHints?.workflowId);
    });
  });
});

// Regression tests for non-web adapter conversations (Gitea, GitHub forge adapters)
// Platform conversation IDs from forge adapters contain slashes and # characters:
// e.g. "CyberFitz-LLC/devops-platform#24" -- these must be URL-encoded by the client
// and correctly decoded by the server route params.
// Ref: https://github.com/coleam00/Archon/issues/476
describe('GET /api/conversations/:id -- forge platform IDs with encoded slashes', () => {
  const GITEA_CONV = {
    id: 'gitea-internal-uuid',
    platform_conversation_id: 'CyberFitz-LLC/devops-platform#24',
    title: 'feat: add context enrichment',
    created_at: new Date(),
    updated_at: new Date(),
    platform_type: 'gitea',
    deleted_at: null,
    codebase_id: null,
  };

  test('finds gitea conversation when ID contains encoded slash and hash', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async platformId => {
      // Server should receive the decoded platform ID (slashes + # restored)
      expect(platformId).toBe('CyberFitz-LLC/devops-platform#24');
      return GITEA_CONV;
    });

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // Client must URL-encode the ID: %2F for slash, %23 for #
    const response = await app.request('/api/conversations/CyberFitz-LLC%2Fdevops-platform%2324');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      platform_conversation_id: string;
      platform_type: string;
    };
    expect(body.platform_conversation_id).toBe('CyberFitz-LLC/devops-platform#24');
    expect(body.platform_type).toBe('gitea');
  });

  test('finds gitea PR conversation with ! separator when ID is encoded', async () => {
    const giteaPRConv = {
      ...GITEA_CONV,
      platform_conversation_id: 'owner/repo!42',
      platform_type: 'gitea',
    };

    mockFindConversationByPlatformId.mockImplementationOnce(async platformId => {
      expect(platformId).toBe('owner/repo!42');
      return giteaPRConv;
    });

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/owner%2Frepo!42');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { platform_conversation_id: string };
    expect(body.platform_conversation_id).toBe('owner/repo!42');
  });

  test('returns 404 for unknown gitea conversation ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/unknown-org%2Funknown-repo%2399');
    expect(response.status).toBe(404);
  });
});
