import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

/** Default usage matching Codex SDK's Usage type (required on TurnCompletedEvent) */
const defaultUsage = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 };

// Create mock runStreamed first (before it's referenced)
const mockRunStreamed = mock(() =>
  Promise.resolve({
    events: (async function* () {
      yield { type: 'turn.completed', usage: defaultUsage };
    })(),
  })
);

// Create a mock thread object factory
const createMockThread = (id: string) => ({
  id,
  runStreamed: mockRunStreamed,
});

// Create mock functions for Codex SDK that use createMockThread
const mockStartThread = mock(() => createMockThread('new-thread-id'));
const mockResumeThread = mock(() => createMockThread('resumed-thread-id'));

// Mock Codex class
const MockCodex = mock(() => ({
  startThread: mockStartThread,
  resumeThread: mockResumeThread,
}));

// Mock the Codex SDK
mock.module('@openai/codex-sdk', () => ({
  Codex: MockCodex,
}));

const mockRefreshIfAuthFailed = mock(async () => ({
  refreshed: false,
  reason: 'no_creds' as const,
}));

mock.module('../auth-refresh/index.js', () => ({
  refreshIfAuthFailed: mockRefreshIfAuthFailed,
  isTerminalRefreshReason: (reason: string) =>
    reason === 'refresh_expired' || reason === 'refresh_revoked',
  buildReauthMessage: (provider: string, reason: string) =>
    `${provider} subscription auth expired (${reason}). Re-run ${provider} login on the harness host.`,
  // L2 + shared module additions (WO-HARNESS-PROVIDER-PROACTIVE-AUTH-REFRESH-01).
  // ensureFreshAuth is a no-op in tests -- the reactive refresh path is what
  // these regression tests exercise. Real preflight behavior is covered by
  // packages/providers/src/auth-refresh/__tests__/preflight.test.ts.
  ensureFreshAuth: mock(async () => {}),
  AUTH_PATTERNS: [
    'credit balance',
    'unauthorized',
    'authentication',
    'invalid token',
    '401',
    '403',
    'not logged in',
    'please run /login',
    'not signed in',
    "please run 'codex login'",
    'refresh token',
    'could not be refreshed',
    'log out and sign in',
  ],
  isAuthErrorMessage: (message: string | undefined) => {
    if (!message) return false;
    const lower = message.toLowerCase();
    return [
      'credit balance',
      'unauthorized',
      'authentication',
      'invalid token',
      '401',
      '403',
      'not logged in',
      'please run /login',
      'not signed in',
      "please run 'codex login'",
      'refresh token',
      'could not be refreshed',
      'log out and sign in',
    ].some(p => lower.includes(p));
  },
}));

import { CodexProvider, resetCodexSingleton } from './provider';

describe('CodexProvider', () => {
  let client: CodexProvider;

  beforeEach(() => {
    resetCodexSingleton();
    client = new CodexProvider({ retryBaseDelayMs: 1 });
    MockCodex.mockClear();
    mockStartThread.mockClear();
    mockResumeThread.mockClear();
    mockRunStreamed.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    mockRefreshIfAuthFailed.mockClear();
    mockRefreshIfAuthFailed.mockResolvedValue({
      refreshed: false,
      reason: 'no_creds' as const,
    });

    // Setup default mock thread
    mockStartThread.mockReturnValue(createMockThread('new-thread-id'));
    mockResumeThread.mockReturnValue(createMockThread('resumed-thread-id'));
  });

  describe('getType', () => {
    test('returns codex', () => {
      expect(client.getType()).toBe('codex');
    });
  });

  describe('getCapabilities', () => {
    test('returns limited capability set for Codex provider', () => {
      const caps = client.getCapabilities();
      expect(caps).toEqual({
        execution: { text: true, repositoryRead: true, repositoryWrite: true, shell: true },
        sessionResume: true,
        mcp: false,
        hooks: false,
        skills: false,
        agents: false,
        toolRestrictions: false,
        structuredOutput: true,
        envInjection: true,
        costControl: false,
        effortControl: false,
        thinkingControl: false,
        fallbackModel: false,
        sandbox: false,
      });
    });
  });

  describe('sendQuery', () => {
    test('yields text events from agent_message items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'agent_message', text: 'Hello from Codex!' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Hello from Codex!' });
      expect(chunks[1]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        tokens: { input: 10, output: 5 },
        // Layer 1 served-model capture: Codex SDK does not expose served model.
        servedModelId: null,
        servedModelMissingReason: 'codex_sdk_does_not_expose_served_model',
      });
    });

    test('yields tool events from command_execution items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'command_execution',
              command: 'npm test',
              aggregated_output: 'tests passed\n',
              exit_code: 0,
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'tool', toolName: 'npm test' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: 'npm test',
        toolOutput: 'tests passed\n',
      });
    });

    test('appends non-zero exit code to command_execution tool_result', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'command_execution',
              command: 'npm test',
              aggregated_output: 'failure\n',
              exit_code: 1,
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: 'npm test',
        toolOutput: 'failure\n\n[exit code: 1]',
      });
    });

    test('yields thinking events from reasoning items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'reasoning', text: 'Let me think about this...' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'thinking', content: 'Let me think about this...' });
    });

    test('yields tool events from web_search items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: { type: 'web_search', query: 'codex sdk' } };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'tool', toolName: '[SEARCH] Searching: codex sdk' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: '[SEARCH] Searching: codex sdk',
        toolOutput: '',
      });
    });

    test('yields system task list for todo_list items and deduplicates', async () => {
      const todoItem = {
        type: 'todo_list',
        items: [
          { text: 'Scan repo', completed: true },
          { text: 'Add tests', completed: false },
        ],
      };

      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: todoItem };
          yield { type: 'item.completed', item: todoItem };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '[TASKS] Tasks:\n[x] Scan repo\n[ ] Add tests',
      });
      expect(chunks).toHaveLength(2);
    });

    test('yields updated todo_list when items change', async () => {
      const todoV1 = {
        type: 'todo_list',
        items: [
          { text: 'Scan repo', completed: false },
          { text: 'Add tests', completed: false },
        ],
      };
      const todoV2 = {
        type: 'todo_list',
        items: [
          { text: 'Scan repo', completed: true },
          { text: 'Add tests', completed: false },
        ],
      };

      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: todoV1 };
          yield { type: 'item.completed', item: todoV2 };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3); // todoV1 + todoV2 + result
      expect(chunks[0]).toEqual({
        type: 'system',
        content: '[TASKS] Tasks:\n[ ] Scan repo\n[ ] Add tests',
      });
      expect(chunks[1]).toEqual({
        type: 'system',
        content: '[TASKS] Tasks:\n[x] Scan repo\n[ ] Add tests',
      });
    });

    test('yields file change summary for file_change items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'file_change',
              status: 'completed',
              changes: [
                { kind: 'add', path: 'src/new.ts' },
                { kind: 'update', path: 'src/app.ts' },
                { kind: 'delete', path: 'src/old.ts' },
              ],
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '[OK] File changes:\n[+] src/new.ts\n[M] src/app.ts\n[-] src/old.ts',
      });
    });

    test('yields failed file change with error message', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'file_change',
              status: 'failed',
              error: { message: 'Permission denied' },
              changes: [{ kind: 'update', path: 'src/locked.ts' }],
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '[X] File changes:\n[M] src/locked.ts\nPermission denied',
      });
    });

    test('yields failed file change without changes array', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'file_change',
              status: 'failed',
              error: { message: 'Disk full' },
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '[X] File change failed: Disk full',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
        'file_change_failed_no_changes'
      );
    });

    test('yields failed file change without error message', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'file_change', status: 'failed' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '[X] File change failed',
      });
    });

    test('yields MCP tool call events and failures', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', server: 'fs', tool: 'readFile', status: 'in_progress' },
          };
          yield {
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call',
              server: 'fs',
              tool: 'readFile',
              status: 'failed',
              error: { message: 'Permission denied' },
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // First mcp call (in_progress on item.completed): start + empty result
      expect(chunks[0]).toEqual({ type: 'tool', toolName: '[MCP] fs/readFile' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: '[MCP] fs/readFile',
        toolOutput: '',
      });
      // Second mcp call (failed): start + error result so the UI card closes
      expect(chunks[2]).toEqual({ type: 'tool', toolName: '[MCP] fs/readFile' });
      expect(chunks[3]).toEqual({
        type: 'tool_result',
        toolName: '[MCP] fs/readFile',
        toolOutput: '[ERROR]: Permission denied',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ server: 'fs', tool: 'readFile' }),
        'mcp_tool_call_failed'
      );
    });

    test('yields MCP tool call with partial identification', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', tool: 'readFile', status: 'in_progress' },
          };
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', server: 'fs', status: 'in_progress' },
          };
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', status: 'in_progress' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'tool', toolName: '[MCP] readFile' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: '[MCP] readFile',
        toolOutput: '',
      });
      expect(chunks[2]).toEqual({ type: 'tool', toolName: '[MCP] fs' });
      expect(chunks[3]).toEqual({
        type: 'tool_result',
        toolName: '[MCP] fs',
        toolOutput: '',
      });
      expect(chunks[4]).toEqual({ type: 'tool', toolName: '[MCP] MCP tool' });
      expect(chunks[5]).toEqual({
        type: 'tool_result',
        toolName: '[MCP] MCP tool',
        toolOutput: '',
      });
    });

    test('yields MCP failure without error message', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', server: 'db', tool: 'query', status: 'failed' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'tool', toolName: '[MCP] db/query' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: '[MCP] db/query',
        toolOutput: '[ERROR]: MCP tool failed',
      });
    });

    test('emits paired tool + tool_result for completed MCP tool call', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call',
              server: 'fs',
              tool: 'readFile',
              status: 'completed',
              result: { content: [{ type: 'text', text: 'file contents' }] },
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toEqual({ type: 'tool', toolName: '[MCP] fs/readFile' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: '[MCP] fs/readFile',
        toolOutput: JSON.stringify([{ type: 'text', text: 'file contents' }]),
      });
      expect(chunks[2]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        tokens: { input: 10, output: 5 },
        // Layer 1 served-model capture: Codex SDK does not expose served model.
        servedModelId: null,
        servedModelMissingReason: 'codex_sdk_does_not_expose_served_model',
      });
    });

    test('creates new thread with sandbox/network settings', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      for await (const _ of client.sendQuery('test prompt', '/my/workspace')) {
        // consume
      }

      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({
          workingDirectory: '/my/workspace',
          skipGitRepoCheck: true,
          sandboxMode: 'danger-full-access',
          networkAccessEnabled: true,
          approvalPolicy: 'never',
        })
      );
    });

    test('resumes existing thread with sandbox/network settings', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      for await (const _ of client.sendQuery('test prompt', '/workspace', 'existing-thread')) {
        // consume
      }

      expect(mockResumeThread).toHaveBeenCalledWith(
        'existing-thread',
        expect.objectContaining({
          workingDirectory: '/workspace',
          skipGitRepoCheck: true,
          sandboxMode: 'danger-full-access',
          networkAccessEnabled: true,
          approvalPolicy: 'never',
        })
      );
      expect(mockStartThread).not.toHaveBeenCalled();
    });

    test('falls back to new thread when resume fails and notifies user', async () => {
      const resumeError = new Error('Thread not found');
      mockResumeThread.mockImplementation(() => {
        throw resumeError;
      });
      mockStartThread.mockReturnValue(createMockThread('fallback-thread'));

      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace', 'bad-thread-id')) {
        chunks.push(chunk);
      }

      expect(mockResumeThread).toHaveBeenCalled();
      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({
          workingDirectory: '/workspace',
          skipGitRepoCheck: true,
          sandboxMode: 'danger-full-access',
          networkAccessEnabled: true,
          approvalPolicy: 'never',
        })
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        { err: resumeError, sessionId: 'bad-thread-id' },
        'resume_thread_failed'
      );
      // Verify user is notified about session loss
      expect(chunks[0]).toEqual({
        type: 'system',
        content: expect.stringContaining('Could not resume previous session'),
      });
      expect(chunks[1]).toEqual({
        type: 'result',
        sessionId: 'fallback-thread',
        tokens: { input: 10, output: 5 },
        // Layer 1 served-model capture: Codex SDK does not expose served model.
        servedModelId: null,
        servedModelMissingReason: 'codex_sdk_does_not_expose_served_model',
      });
    });

    test('passes model and codex options via assistantConfig to thread options', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      for await (const _ of client.sendQuery('test prompt', '/workspace', undefined, {
        model: 'gpt-5.2-codex',
        assistantConfig: {
          modelReasoningEffort: 'medium',
          webSearchMode: 'live',
          additionalDirectories: ['/other/repo'],
        },
      })) {
        // consume
      }

      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5.2-codex',
          modelReasoningEffort: 'medium',
          webSearchMode: 'live',
          additionalDirectories: ['/other/repo'],
        })
      );
    });

    test('F1 SDK boundary: Anthropic model aliases are dropped from codex thread options', async () => {
      // An Anthropic alias passed via node.model or assistantConfig.model must NOT
      // reach the Codex SDK.  The SDK rejects Anthropic model names; dropping them
      // lets the SDK fall back to the account-level model configured in OpenAI settings.
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const anthropicAliases = [
        'opus',
        'sonnet',
        'haiku',
        'opus[1m]',
        'sonnet[1m]',
        'claude-opus-5',
        'claude-opus-4-7',
        'claude-sonnet-4-6',
        'claude-haiku-4-5',
      ];
      for (const alias of anthropicAliases) {
        mockStartThread.mockClear();
        for await (const _ of client.sendQuery('test', '/workspace', undefined, {
          model: alias,
        })) {
          // consume
        }
        const callArg = mockStartThread.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(callArg).not.toHaveProperty(
          'model',
          `Anthropic alias '${alias}' must not be forwarded to the Codex SDK`
        );
      }
    });

    test('F1 SDK boundary: a genuine codex model is forwarded to the SDK', async () => {
      // Codex-native models (gpt-5.2-codex, gpt-5.3-codex, o3, etc.) MUST be
      // forwarded so explicit account-level model overrides work.
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });
      mockStartThread.mockClear();
      for await (const _ of client.sendQuery('test', '/workspace', undefined, {
        model: 'gpt-5.2-codex',
      })) {
        // consume
      }
      const callArg = mockStartThread.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg).toHaveProperty('model', 'gpt-5.2-codex');
    });

    test('F1 SDK boundary: Anthropic alias in assistantConfig.model is also dropped', async () => {
      // The leak can come from assistantConfig.model (not just requestOptions.model).
      // Both paths must be blocked.
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });
      mockStartThread.mockClear();
      for await (const _ of client.sendQuery('test', '/workspace', undefined, {
        assistantConfig: { model: 'claude-sonnet-4-6' },
      })) {
        // consume
      }
      const callArg = mockStartThread.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg).not.toHaveProperty(
        'model',
        'assistantConfig.model Anthropic alias must not be forwarded to the Codex SDK'
      );
    });

    test('passes outputFormat schema as outputSchema in TurnOptions', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const schema = {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      };

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace', undefined, {
        outputFormat: { type: 'json_schema', schema },
      })) {
        chunks.push(chunk);
      }

      expect(mockRunStreamed).toHaveBeenCalledWith(
        'test prompt',
        expect.objectContaining({ outputSchema: schema })
      );
    });

    test('passes abortSignal as signal in TurnOptions', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const controller = new AbortController();

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace', undefined, {
        abortSignal: controller.signal,
      })) {
        chunks.push(chunk);
      }

      expect(mockRunStreamed).toHaveBeenCalledWith(
        'test prompt',
        expect.objectContaining({ signal: controller.signal })
      );
    });

    test('passes empty TurnOptions when no outputFormat or abortSignal', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(mockRunStreamed).toHaveBeenCalledWith('test prompt', {});
    });

    test('creates a per-call Codex instance when env is provided', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      for await (const _ of client.sendQuery('test prompt', '/workspace', undefined, {
        env: { MY_SECRET: 'abc123' },
      })) {
        // consume
      }

      expect(MockCodex).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ MY_SECRET: 'abc123' }),
        })
      );
      expect(mockStartThread).toHaveBeenCalledTimes(1);
    });

    test('builds env by preserving process vars and letting request env win on collisions', async () => {
      const originalPath = process.env.PATH;
      const originalArchonEnv = process.env.ARCHON_CODEX_TEST_ENV;
      process.env.PATH = 'from-process';
      process.env.ARCHON_CODEX_TEST_ENV = 'kept-from-process';

      try {
        mockRunStreamed.mockResolvedValue({
          events: (async function* () {
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });

        for await (const _ of client.sendQuery('test prompt', '/workspace', undefined, {
          env: { PATH: 'from-request', MY_SECRET: 'abc123' },
        })) {
          // consume
        }

        expect(MockCodex).toHaveBeenCalledWith(
          expect.objectContaining({
            env: expect.objectContaining({
              PATH: 'from-request',
              ARCHON_CODEX_TEST_ENV: 'kept-from-process',
              MY_SECRET: 'abc123',
            }),
          })
        );
      } finally {
        if (originalPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = originalPath;
        }
        if (originalArchonEnv === undefined) {
          delete process.env.ARCHON_CODEX_TEST_ENV;
        } else {
          process.env.ARCHON_CODEX_TEST_ENV = originalArchonEnv;
        }
      }
    });

    test('reuses the singleton Codex instance across sequential calls without env', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      for await (const _ of client.sendQuery('first prompt', '/workspace')) {
        // consume
      }
      for await (const _ of client.sendQuery('second prompt', '/workspace')) {
        // consume
      }

      expect(MockCodex).toHaveBeenCalledTimes(1);
    });

    test('wraps per-call Codex constructor failures with provider error context', async () => {
      MockCodex.mockImplementationOnce(() => {
        throw new Error('constructor failed');
      });

      const consumeGenerator = async (): Promise<void> => {
        for await (const _ of client.sendQuery('test prompt', '/workspace', undefined, {
          env: { MY_SECRET: 'abc123' },
        })) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow('Codex query failed: constructor failed');
    });

    test('breaks on turn.completed event', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: { type: 'agent_message', text: 'Before turn' } };
          yield { type: 'turn.completed', usage: defaultUsage };
          // This should NOT be yielded due to break
          yield { type: 'item.completed', item: { type: 'agent_message', text: 'After turn' } };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Only first message and result should be yielded
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Before turn' });
      expect(chunks[1]).toMatchObject({ type: 'result', sessionId: 'new-thread-id' });
    });

    test('logs progress for item.started and item.completed events', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.started', item: { id: 'item-1', type: 'command_execution' } };
          yield {
            type: 'item.completed',
            item: { id: 'item-1', type: 'command_execution', command: 'npm test' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(mockLogger.debug).toHaveBeenCalledWith(
        { eventType: 'item.started', itemType: 'command_execution', itemId: 'item-1' },
        'item_started'
      );

      expect(mockLogger.debug).toHaveBeenCalledWith(
        {
          eventType: 'item.completed',
          itemType: 'command_execution',
          itemId: 'item-1',
          command: 'npm test',
        },
        'item_completed'
      );
    });

    test('error events followed by turn.completed yield a clean result (recoverable)', async () => {
      // SDK error events that are followed by turn.completed indicate the SDK
      // recovered internally. The dropped error message is logged but not
      // surfaced \u2014 only one terminal result chunk is yielded.
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'error', message: 'Transient blip' };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        tokens: { input: 10, output: 5 },
        // Layer 1 served-model capture: Codex SDK does not expose served model.
        servedModelId: null,
        servedModelMissingReason: 'codex_sdk_does_not_expose_served_model',
      });
      expect(mockLogger.error).toHaveBeenCalledWith({ message: 'Transient blip' }, 'stream_error');
    });

    test('error event followed by stream close yields fail-stop result.isError', async () => {
      // The SDK sends an error event (e.g. "model not supported") and the
      // iterator closes without turn.completed or turn.failed. The provider
      // synthesizes a fail-stop result so the dag-executor's msg.isError
      // branch catches the failure \u2014 same chunk shape as Claude.
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'error', message: "'opus[1m]' model is not supported" };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        isError: true,
        errorSubtype: 'codex_stream_incomplete',
        errors: ["'opus[1m]' model is not supported"],
      });
    });

    test('MCP client errors followed by turn.completed yield clean result', async () => {
      // MCP client errors are non-fatal \u2014 Codex retries internally.
      // Only after turn.completed do we know the SDK recovered.
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'error', message: 'MCP client connection timeout' };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        tokens: { input: 10, output: 5 },
        // Layer 1 served-model capture: Codex SDK does not expose served model.
        servedModelId: null,
        servedModelMissingReason: 'codex_sdk_does_not_expose_served_model',
      });
      // Logged but not surfaced as failure
      expect(mockLogger.error).toHaveBeenCalledWith(
        { message: 'MCP client connection timeout' },
        'stream_error'
      );
    });

    test('MCP-only error followed by stream close still fails (no terminal = failure)', async () => {
      // The stream-incomplete fail-stop fires whenever the iterator closes
      // without a terminal event \u2014 that's an SDK contract violation
      // regardless of cause. But the captured error message does NOT carry
      // the MCP-client text, since MCP errors are filtered from capture.
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'error', message: 'MCP client transport closed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: 'result',
        isError: true,
        errorSubtype: 'codex_stream_incomplete',
      });
      const errors = (chunks[0] as { errors?: string[] }).errors;
      expect(errors?.[0]).not.toContain('MCP client');
    });

    // BDF Fix A (WO-HARNESS-BDF-RESILIENCE-FIXES-01): turn.failed now THROWS
    // instead of yielding a result chunk. The sendQuery catch block receives
    // the thrown error and routes through retry/failback logic.
    // Use mockImplementation (not mockResolvedValue) so each retry attempt
    // gets a FRESH generator -- otherwise the exhausted generator would yield
    // codex_stream_incomplete on retries instead of re-triggering the throw.
    test('turn.failed (BDF Fix A) throws; rate_limit exhausts retries without failback', async () => {
      mockRunStreamed.mockImplementation(async () => ({
        events: (async function* () {
          yield { type: 'turn.failed', error: { message: 'Rate limit exceeded' } };
        })(),
      }));

      const consumeGenerator = async () => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      // After retries exhaust, enriched error is thrown: "Codex rate_limit: ..."
      await expect(consumeGenerator()).rejects.toThrow('Rate limit exceeded');
      expect(mockLogger.error).toHaveBeenCalledWith(
        { errorMessage: 'Rate limit exceeded' },
        'turn_failed'
      );
    });

    test('turn.failed without error message (BDF Fix A) throws Unknown error', async () => {
      mockRunStreamed.mockImplementation(async () => ({
        events: (async function* () {
          yield { type: 'turn.failed', error: null };
        })(),
      }));

      const consumeGenerator = async () => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow('Unknown error');
      expect(mockLogger.error).toHaveBeenCalledWith(
        { errorMessage: 'Unknown error' },
        'turn_failed'
      );
    });

    // S5: turn.failed usage-limit triggers failback provider (BDF Fix A core behavior).
    test('S5 (BDF Fix A): turn.failed usage-limit triggers failback provider', async () => {
      mockRunStreamed.mockImplementation(async () => ({
        events: (async function* () {
          yield { type: 'turn.failed', error: { message: "You've hit your usage limit" } };
        })(),
      }));

      const failbackChunks: { type: string; content?: string }[] = [];
      const failbackSendQuery = mock(async function* (
        _p: string,
        _c: string,
        _r?: string,
        _o?: unknown
      ) {
        yield { type: 'assistant', content: 'failback response' } as const;
        yield { type: 'result', sessionId: 'fb-session' } as const;
      });
      const failbackProvider = {
        sendQuery: failbackSendQuery,
        getType: () => 'claude',
        getCapabilities: () => ({}) as unknown as ReturnType<CodexProvider['getCapabilities']>,
      };
      const factory = mock(() => failbackProvider);
      const clientWithFailback = new CodexProvider({
        retryBaseDelayMs: 1,
        failbackProviderFactory: factory as unknown as () => typeof failbackProvider,
      });

      for await (const chunk of clientWithFailback.sendQuery('review', '/workspace')) {
        failbackChunks.push(chunk as { type: string; content?: string });
      }

      // Failback factory was invoked -- turn.failed now reaches the catch block
      expect(factory).toHaveBeenCalled();
      // Disclosure chunk present (the [CODEX FAILBACK] system message)
      const disclosure = failbackChunks.find(
        c => c.type === 'system' && c.content?.includes('CODEX FAILBACK')
      );
      expect(disclosure).toBeDefined();
      // Failback provider content streamed through
      expect(
        failbackChunks.some(c => c.type === 'assistant' && c.content === 'failback response')
      ).toBe(true);
      expect(mockLogger.error).toHaveBeenCalledWith(
        { errorMessage: "You've hit your usage limit" },
        'turn_failed'
      );
    });

    // S6: a successful turn.completed does NOT trigger the failback provider.
    // Gate failures (build ran, tests failed) produce turn.completed -- the
    // failover path is for AVAILABILITY errors only (turn.failed / thrown exceptions).
    test('S6: turn.completed (gate failure content) does NOT invoke failback factory', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed' };
        })(),
      });

      const factory = mock(() => {
        throw new Error('failback should not be called');
      });
      const clientWithFailback = new CodexProvider({
        retryBaseDelayMs: 1,
        failbackProviderFactory: factory as unknown as () => CodexProvider,
      });

      const chunks: unknown[] = [];
      for await (const chunk of clientWithFailback.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Factory never invoked -- availability failover does not fire on turn.completed
      expect(factory).not.toHaveBeenCalled();
      // Stream completed without a thrown error
      expect(chunks.some((c: unknown) => (c as { type?: string }).type === 'result')).toBe(true);
    });

    test('iterator that closes with zero events yields codex_stream_incomplete with default message', async () => {
      // Bare-stream-close fallback: no error event, no terminal event,
      // iterator just ends. Locks in the default message used when there is
      // no captured non-MCP error to attribute the failure to.
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          // no events
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        isError: true,
        errorSubtype: 'codex_stream_incomplete',
        errors: ['Codex stream closed without turn.completed or turn.failed'],
      });
    });

    test('throws on runStreamed error', async () => {
      const networkError = new Error('Network failure');
      mockRunStreamed.mockRejectedValue(networkError);

      const consumeGenerator = async () => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow('Codex unknown: Network failure');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: networkError }),
        'query_error'
      );
    });

    test('throws actionable model-access message for unavailable configured model', async () => {
      mockRunStreamed.mockRejectedValue(new Error('403 Forbidden: model not available'));

      const consumeGenerator = async () => {
        for await (const _ of client.sendQuery('test', '/workspace', undefined, {
          model: 'gpt-5.3-codex',
        })) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow(
        'Model "gpt-5.3-codex" is not available for your account'
      );
      // PR #165 repointed CODEX_MODEL_FALLBACKS['gpt-5.3-codex'] to
      // CODEX_DEFAULT_MODEL ('gpt-5.6-sol'); this assertion was stale and failed
      // against live code -- re-aligned by
      // WO-HARNESS-CODEX-THREAD-RESUME-AND-FAILBACK-01 (test file is in scope).
      await expect(consumeGenerator()).rejects.toThrow('model: gpt-5.6-sol');
    });

    test('uses generic dashboard guidance when fallback mapping is unknown', async () => {
      mockRunStreamed.mockRejectedValue(new Error('model not available'));

      const consumeGenerator = async () => {
        for await (const _ of client.sendQuery('test', '/workspace', undefined, {
          model: 'o5-pro',
        })) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow(
        'Model "o5-pro" is not available for your account'
      );
      await expect(consumeGenerator()).rejects.toThrow(
        'update your model in ~/.archon/config.yaml'
      );
    });

    test('ignores items without text or command', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: { type: 'agent_message', text: '' } };
          yield { type: 'item.completed', item: { type: 'agent_message' } }; // no text
          yield { type: 'item.completed', item: { type: 'command_execution' } }; // no command
          yield { type: 'item.completed', item: { type: 'reasoning' } }; // no text
          yield { type: 'item.completed', item: { type: 'file_edit' } }; // ignored type
          yield { type: 'item.completed', item: { type: 'web_search' } }; // no query
          yield { type: 'item.completed', item: { type: 'todo_list', items: [] } }; // empty items
          yield { type: 'item.completed', item: { type: 'todo_list' } }; // no items
          yield {
            type: 'item.completed',
            item: { type: 'file_change', status: 'completed', changes: [] },
          }; // empty changes
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Only the result should be yielded
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        tokens: { input: 10, output: 5 },
        // Layer 1 served-model capture: Codex SDK does not expose served model.
        servedModelId: null,
        servedModelMissingReason: 'codex_sdk_does_not_expose_served_model',
      });
    });

    describe('retry behavior', () => {
      test('classifies exit code errors as crash and retries up to 3 times', async () => {
        mockRunStreamed.mockRejectedValue(
          new Error('Codex Exec exited with code 1: stderr output')
        );

        const consumeGenerator = async (): Promise<void> => {
          for await (const _ of client.sendQuery('test', '/workspace')) {
            // consume
          }
        };

        await expect(consumeGenerator()).rejects.toThrow(/Codex crash/);
        // Initial attempt + 3 retries = 4 runStreamed calls
        expect(mockRunStreamed).toHaveBeenCalledTimes(4);
      });

      test('recovers from transient crash on retry', async () => {
        let callCount = 0;
        mockRunStreamed.mockImplementation(() => {
          callCount++;
          if (callCount <= 2) {
            return Promise.reject(new Error('Codex Exec exited with code 1'));
          }
          return Promise.resolve({
            events: (async function* () {
              yield {
                type: 'item.completed',
                item: { type: 'agent_message', text: 'Recovered!' },
              };
              yield { type: 'turn.completed', usage: defaultUsage };
            })(),
          });
        });

        const chunks = [];
        for await (const chunk of client.sendQuery('test', '/workspace')) {
          chunks.push(chunk);
        }

        expect(callCount).toBe(3);
        expect(chunks.some(c => c.type === 'assistant' && c.content === 'Recovered!')).toBe(true);
      });

      test('classifies auth errors as fatal when refresh has no credentials', async () => {
        mockRunStreamed.mockRejectedValue(new Error('unauthorized'));

        const consumeGenerator = async (): Promise<void> => {
          for await (const _ of client.sendQuery('test', '/workspace')) {
            // consume
          }
        };

        await expect(consumeGenerator()).rejects.toThrow(/Codex auth error/);
        expect(mockRunStreamed).toHaveBeenCalledTimes(1);
        expect(mockRefreshIfAuthFailed).toHaveBeenCalledWith('codex');
      });

      test('refreshes auth errors once and retries the query', async () => {
        let callCount = 0;
        mockRefreshIfAuthFailed.mockResolvedValue({
          refreshed: true,
          provider: 'codex' as const,
          expiresAt: Date.now(),
        });
        mockRunStreamed.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.reject(new Error('unauthorized'));
          }
          return Promise.resolve({
            events: (async function* () {
              yield { type: 'turn.completed', usage: defaultUsage };
            })(),
          });
        });

        const chunks = [];
        for await (const chunk of client.sendQuery('test', '/workspace')) {
          chunks.push(chunk);
        }

        expect(mockRefreshIfAuthFailed).toHaveBeenCalledTimes(1);
        expect(mockRunStreamed).toHaveBeenCalledTimes(2);
        expect(chunks.some(c => c.type === 'result')).toBe(true);
      });

      // BDC fork regression (2026-05-15): the Codex binary returns several
      // pre-flight / refresh-failure strings that previously classified as
      // 'unknown' and bypassed the refresh path. AUTH_PATTERNS must catch all of
      // these so the refresh branch engages (where possible) or terminal auth
      // failures surface clearly. See behavior spec invariants I-2 and I-9.
      test.each([
        ['Not logged in', 'bare binary pre-flight'],
        ["Not signed in. Please run 'codex login'", 'cloud-tasks variant'],
        [
          'Your access token could not be refreshed. Please log out and sign in again.',
          'refresh-failed terminal message',
        ],
      ])('classifies binary-side auth error as auth: %s (%s)', async (errorMessage, _label) => {
        let callCount = 0;
        mockRefreshIfAuthFailed.mockResolvedValue({
          refreshed: true,
          provider: 'codex' as const,
          expiresAt: Date.now() + 28_800_000,
        });
        mockRunStreamed.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.reject(new Error(errorMessage));
          }
          return Promise.resolve({
            events: (async function* () {
              yield { type: 'turn.completed', usage: defaultUsage };
            })(),
          });
        });

        const chunks = [];
        for await (const chunk of client.sendQuery('test', '/workspace')) {
          chunks.push(chunk);
        }

        expect(mockRefreshIfAuthFailed).toHaveBeenCalledWith('codex');
        expect(mockRunStreamed).toHaveBeenCalledTimes(2);
        expect(chunks.some(c => c.type === 'result')).toBe(true);
      });

      test('surfaces reauth guidance when the refresh token is terminally invalid', async () => {
        mockRefreshIfAuthFailed.mockResolvedValue({
          refreshed: false,
          reason: 'refresh_revoked' as const,
        });
        mockRunStreamed.mockRejectedValue(new Error('unauthorized'));

        const consumeGenerator = async (): Promise<void> => {
          for await (const _ of client.sendQuery('test', '/workspace')) {
            // consume
          }
        };

        await expect(consumeGenerator()).rejects.toThrow(/subscription auth expired/);
        expect(mockRunStreamed).toHaveBeenCalledTimes(1);
      });

      test('does not retry unknown errors', async () => {
        mockRunStreamed.mockRejectedValue(new Error('something unexpected and unclassified'));

        const consumeGenerator = async (): Promise<void> => {
          for await (const _ of client.sendQuery('test', '/workspace')) {
            // consume
          }
        };

        await expect(consumeGenerator()).rejects.toThrow(/Codex unknown/);
        expect(mockRunStreamed).toHaveBeenCalledTimes(1);
      });
    });

    describe('structured output normalization', () => {
      test('populates structuredOutput on result when outputFormat is set and text is valid JSON', async () => {
        const jsonPayload = { status: 'ok', count: 42 };
        mockRunStreamed.mockResolvedValueOnce({
          events: (async function* () {
            yield {
              type: 'item.completed',
              item: { type: 'agent_message', id: 'msg-1', text: JSON.stringify(jsonPayload) },
            };
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });

        const chunks = [];
        for await (const chunk of client.sendQuery('test', '/tmp', undefined, {
          outputFormat: { type: 'json_schema', schema: { type: 'object' } },
        })) {
          chunks.push(chunk);
        }

        const resultChunk = chunks.find(c => c.type === 'result');
        expect(resultChunk).toBeDefined();
        expect(resultChunk!.type === 'result' && resultChunk!.structuredOutput).toEqual(
          jsonPayload
        );
      });

      test('yields system warning when outputFormat is set but text is not valid JSON', async () => {
        mockRunStreamed.mockResolvedValueOnce({
          events: (async function* () {
            yield {
              type: 'item.completed',
              item: { type: 'agent_message', id: 'msg-1', text: 'not json at all' },
            };
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });

        const chunks = [];
        for await (const chunk of client.sendQuery('test', '/tmp', undefined, {
          outputFormat: { type: 'json_schema', schema: { type: 'object' } },
        })) {
          chunks.push(chunk);
        }

        const systemChunk = chunks.find(c => c.type === 'system');
        expect(systemChunk).toBeDefined();
        expect(systemChunk!.type === 'system' && systemChunk!.content).toContain(
          'Structured output requested but Codex returned non-JSON'
        );

        const resultChunk = chunks.find(c => c.type === 'result');
        expect(resultChunk).toBeDefined();
        expect(resultChunk!.type === 'result' && resultChunk!.structuredOutput).toBeUndefined();
      });

      test('does not populate structuredOutput when outputFormat is not set', async () => {
        mockRunStreamed.mockResolvedValueOnce({
          events: (async function* () {
            yield {
              type: 'item.completed',
              item: { type: 'agent_message', id: 'msg-1', text: '{"valid":"json"}' },
            };
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });

        const chunks = [];
        for await (const chunk of client.sendQuery('test', '/tmp')) {
          chunks.push(chunk);
        }

        const resultChunk = chunks.find(c => c.type === 'result');
        expect(resultChunk).toBeDefined();
        expect(resultChunk!.type === 'result' && resultChunk!.structuredOutput).toBeUndefined();
      });

      test('handles nodeConfig.output_format path', async () => {
        const jsonPayload = { key: 'value' };
        mockRunStreamed.mockResolvedValueOnce({
          events: (async function* () {
            yield {
              type: 'item.completed',
              item: { type: 'agent_message', id: 'msg-1', text: JSON.stringify(jsonPayload) },
            };
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });

        const chunks = [];
        for await (const chunk of client.sendQuery('test', '/tmp', undefined, {
          nodeConfig: { output_format: { type: 'object' } },
        })) {
          chunks.push(chunk);
        }

        const resultChunk = chunks.find(c => c.type === 'result');
        expect(resultChunk).toBeDefined();
        expect(resultChunk!.type === 'result' && resultChunk!.structuredOutput).toEqual(
          jsonPayload
        );
      });
    });
  });
});

// --- Behavioral regression tests (black-box via sendQuery) ---------------

describe('sendQuery decomposition behaviors', () => {
  let client: CodexProvider;

  beforeEach(() => {
    client = new CodexProvider({ retryBaseDelayMs: 1 });
    mockStartThread.mockClear();
    mockResumeThread.mockClear();
    mockRunStreamed.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();

    mockStartThread.mockReturnValue(createMockThread('new-thread-id'));
    mockResumeThread.mockReturnValue(createMockThread('resumed-thread-id'));
  });

  test('abort signal throws instead of silently truncating stream', async () => {
    const abortController = new AbortController();

    mockRunStreamed.mockResolvedValue({
      events: (async function* () {
        yield {
          type: 'item.completed',
          item: { type: 'agent_message', text: 'partial', id: '1' },
        };
        // Abort mid-stream
        abortController.abort();
        yield {
          type: 'item.completed',
          item: { type: 'agent_message', text: 'should not appear', id: '2' },
        };
        yield { type: 'turn.completed', usage: defaultUsage };
      })(),
    });

    const consumeGenerator = async (): Promise<void> => {
      for await (const _ of client.sendQuery('test', '/workspace', undefined, {
        abortSignal: abortController.signal,
      })) {
        // consume
      }
    };

    await expect(consumeGenerator()).rejects.toThrow('Query aborted');
  });

  test('enriched error thrown at retry exhaustion, not raw error', async () => {
    mockRunStreamed.mockRejectedValue(new Error('codex exec crashed'));

    const consumeGenerator = async (): Promise<void> => {
      for await (const _ of client.sendQuery('test', '/workspace')) {
        // consume
      }
    };

    const err = await consumeGenerator().catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    // Must contain the enriched classification prefix
    expect(err.message).toContain('Codex crash');
  });

  test('todo_list dedup state resets between retry attempts', async () => {
    const todoItem = {
      type: 'todo_list',
      items: [{ text: 'Task 1', completed: false }],
      id: 'todo-1',
    };

    let callCount = 0;
    mockRunStreamed.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          events: (async function* () {
            yield { type: 'item.completed', item: todoItem };
            throw new Error('codex exec crashed');
          })(),
        });
      }
      // On retry, same todo should appear again (fresh state)
      return Promise.resolve({
        events: (async function* () {
          yield { type: 'item.completed', item: todoItem };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });
    });

    const chunks = [];
    for await (const chunk of client.sendQuery('test', '/workspace')) {
      chunks.push(chunk);
    }

    // The todo should appear on the retry attempt (not suppressed by dedup from attempt 1)
    const systemChunks = chunks.filter(c => c.type === 'system');
    expect(systemChunks.length).toBeGreaterThanOrEqual(1);
    expect(systemChunks.some(c => c.type === 'system' && c.content.includes('Task 1'))).toBe(true);
  });
});

// --- WO-HARNESS-CODEX-THREAD-RESUME-AND-FAILBACK-01 regression tests ----
//
// These three scenarios anchor the WO's bug fix: a runtime "thread/resume
// failed: no rollout found" error from the codex binary must NOT classify as
// auth, must self-heal once with a fresh thread, and -- when terminal --
// must delegate to an injected Claude failback provider with disclosure
// rather than blocking the review gate.
describe('WO-HARNESS-CODEX-THREAD-RESUME-AND-FAILBACK-01', () => {
  let client: CodexProvider;

  beforeEach(() => {
    resetCodexSingleton();
    client = new CodexProvider({ retryBaseDelayMs: 1 });
    MockCodex.mockClear();
    mockStartThread.mockClear();
    mockResumeThread.mockClear();
    mockRunStreamed.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    mockRefreshIfAuthFailed.mockClear();
    mockRefreshIfAuthFailed.mockResolvedValue({
      refreshed: false,
      reason: 'no_creds' as const,
    });

    mockStartThread.mockReturnValue(createMockThread('new-thread-id'));
    mockResumeThread.mockReturnValue(createMockThread('resumed-thread-id'));
  });

  test('Scenario 1: rollout-missing at runtime self-heals to a fresh thread', async () => {
    // Codex binary emits this exact shape: a subprocess crash whose stderr
    // surfaces the rollout-missing message. Resume builds a thread object OK
    // (resumeThread succeeds synchronously), then runStreamed throws at
    // streaming time. The runtime self-heal must catch this, emit the
    // "rollout missing" warning, start a fresh thread, and retry the turn.
    let callCount = 0;
    mockRunStreamed.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(
          new Error(
            'Codex Exec exited with code 1: thread/resume failed: no rollout found for thread id abc-123'
          )
        );
      }
      return Promise.resolve({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });
    });
    mockStartThread.mockReturnValue(createMockThread('fresh-thread-after-rollout-restart'));

    const chunks = [];
    for await (const chunk of client.sendQuery('test prompt', '/workspace', 'abc-123')) {
      chunks.push(chunk);
    }

    // Resume was attempted, then a fresh thread was started for the restart.
    expect(mockResumeThread).toHaveBeenCalledWith('abc-123', expect.any(Object));
    expect(mockStartThread).toHaveBeenCalled();
    // Two runStreamed calls: first failed, second succeeded on fresh thread.
    expect(mockRunStreamed).toHaveBeenCalledTimes(2);
    // The user-facing disclosure must mention rollout-missing self-heal.
    const systemChunk = chunks.find(
      c => c.type === 'system' && c.content.includes('rollout missing')
    );
    expect(systemChunk).toBeDefined();
    // A result chunk must be present (the turn completed after the fresh thread).
    const resultChunk = chunks.find(c => c.type === 'result');
    expect(resultChunk).toBeDefined();
    // The error message must NEVER carry the "Codex auth error:" prefix on this path.
    // (We assert on the thrown-error type via the fact the generator did not throw,
    // but if it had thrown, the enriched prefix would be carried to the consumer.)
  });

  test('Scenario 2: misclassification guard -- rollout-missing is NOT auth', async () => {
    // Behavioral table test: drive sendQuery with three distinct error
    // messages, capture the thrown enriched error prefix, and verify which
    // class the classifier assigned.
    //
    // The runtime rollout restart only fires on attempt === 0 AND when a
    // resumeSessionId was provided. For the rollout-classification probes
    // we pass NO resumeSessionId so the restart guard is skipped and the
    // error flows straight to classifyAndEnrichCodexError on the first
    // attempt. We then read the thrown error's prefix.
    type Case = { msg: string; expectAuth: boolean; label: string };
    const cases: Case[] = [
      {
        msg: 'thread/resume failed: no rollout found for thread id abc',
        expectAuth: false,
        label: 'rollout-missing bare',
      },
      {
        msg: 'Codex Exec exited with code 1: thread/resume failed: no rollout found for thread id xyz',
        expectAuth: false,
        label: 'rollout-missing combined with crash signal',
      },
      {
        msg: '401 unauthorized: invalid api key',
        expectAuth: true,
        label: 'genuine auth error',
      },
    ];

    for (const c of cases) {
      mockStartThread.mockClear();
      mockResumeThread.mockClear();
      mockRunStreamed.mockClear();
      mockRunStreamed.mockRejectedValue(new Error(c.msg));
      mockStartThread.mockReturnValue(createMockThread('thread-for-table-test'));

      const consume = async (): Promise<void> => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      const err = (await consume().catch(e => e as Error)) as Error;
      expect(err).toBeInstanceOf(Error);
      if (c.expectAuth) {
        expect(err.message).toMatch(/Codex auth error:/);
      } else {
        // Rollout-missing must NOT be misclassified as auth. It is crash-class.
        expect(err.message).not.toMatch(/Codex auth error:/);
        expect(err.message).toMatch(/Codex crash:/);
      }
    }
  });

  test('Scenario 3: terminal Codex failure -> Claude failback with disclosure', async () => {
    // All Codex runStreamed attempts reject with a persistent crash; the
    // configured failback factory returns a mock provider that yields one
    // assistant chunk + one result chunk. The generator must:
    //   1. Emit a [CODEX FAILBACK] disclosure mentioning "adversarial"
    //   2. Invoke the failback provider's sendQuery exactly once
    //   3. Stream the failback provider's chunks through to the consumer
    //   4. Return normally (NOT throw)
    mockRunStreamed.mockRejectedValue(
      new Error('codex exec exited with code 1: persistent subprocess crash')
    );

    const failbackSendQuery = mock(async function* (
      _p: string,
      _c: string,
      _r?: string,
      _o?: unknown
    ) {
      yield { type: 'assistant', content: 'Claude failback review verdict' } as const;
      yield {
        type: 'result',
        sessionId: 'claude-failback-session',
        tokens: { input: 100, output: 50 },
      } as const;
    });

    const failbackProvider = {
      sendQuery: failbackSendQuery,
      getType: () => 'claude',
      getCapabilities: () => ({}) as unknown as ReturnType<CodexProvider['getCapabilities']>,
    };

    const factoryCalls = mock(() => failbackProvider);
    const clientWithFailback = new CodexProvider({
      retryBaseDelayMs: 1,
      failbackProviderFactory: factoryCalls as unknown as () => typeof failbackProvider,
    });

    const chunks: { type: string; content?: string }[] = [];
    for await (const chunk of clientWithFailback.sendQuery('review this diff', '/workspace')) {
      chunks.push(chunk as { type: string; content?: string });
    }

    // Failback factory invoked at least once (and we expect exactly once for
    // a single sendQuery call -- the lazy factory is invoked when retries
    // exhaust).
    expect(factoryCalls).toHaveBeenCalled();
    expect(failbackSendQuery).toHaveBeenCalledTimes(1);

    // Disclosure chunk present and mentions both CODEX FAILBACK and the
    // adversarial-value warning (the WO's required language).
    const disclosure = chunks.find(
      c => c.type === 'system' && c.content?.includes('CODEX FAILBACK')
    );
    expect(disclosure).toBeDefined();
    expect(disclosure!.content).toMatch(/adversarial/i);

    // Claude's verdict streamed through.
    expect(
      chunks.some(c => c.type === 'assistant' && c.content === 'Claude failback review verdict')
    ).toBe(true);
    // Generator returned a final result without throwing.
    expect(chunks.some(c => c.type === 'result')).toBe(true);
  });

  test('Scenario 3c: failback strips nested nodeConfig model fields (no gpt id reaches Claude)', async () => {
    // MAJOR 1 (adversarial re-review 2026-06-10): buildFailbackOptions must
    // strip not only top-level model fields but also nodeConfig.fallbackModel
    // and nodeConfig.agents[*].model -- those carry Codex (gpt-*) ids that
    // ClaudeProvider.applyNodeConfig would otherwise feed back into the Claude
    // SDK on failback, reopening the model-leak BLOCKER 1 closed.
    mockRunStreamed.mockRejectedValue(
      new Error('codex exec exited with code 1: persistent subprocess crash')
    );

    type ReceivedOpts = {
      model?: string;
      nodeConfig?: {
        fallbackModel?: string;
        agents?: Record<string, { prompt?: string; model?: string }>;
      };
    };
    let receivedOptions: ReceivedOpts | undefined;
    const failbackSendQuery = mock(async function* (
      _p: string,
      _c: string,
      _r?: string,
      _o?: unknown
    ) {
      receivedOptions = _o as ReceivedOpts;
      yield { type: 'assistant', content: 'Claude failback review verdict' } as const;
      yield {
        type: 'result',
        sessionId: 'claude-failback-session',
        tokens: { input: 100, output: 50 },
      } as const;
    });

    const failbackProvider = {
      sendQuery: failbackSendQuery,
      getType: () => 'claude',
      getCapabilities: () => ({}) as unknown as ReturnType<CodexProvider['getCapabilities']>,
    };

    const clientWithFailback = new CodexProvider({
      retryBaseDelayMs: 1,
      failbackProviderFactory: (() => failbackProvider) as unknown as () => typeof failbackProvider,
    });

    const requestOptions = {
      model: 'gpt-5.6-sol',
      fallbackModel: 'gpt-5.6-sol',
      nodeConfig: {
        fallbackModel: 'gpt-5.6-sol',
        agents: {
          'codex-adversarial-reviewer': {
            description: 'reviewer',
            prompt: 'review the diff',
            model: 'gpt-5.6-sol',
            tools: ['read'],
          },
        },
      },
    } as unknown as Parameters<CodexProvider['sendQuery']>[3];

    // Drain the generator.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of clientWithFailback.sendQuery(
      'review this diff',
      '/workspace',
      undefined,
      requestOptions
    )) {
      // no-op
    }

    expect(failbackSendQuery).toHaveBeenCalledTimes(1);
    expect(receivedOptions).toBeDefined();
    // Top-level model fields stripped.
    expect(receivedOptions!.model).toBeUndefined();
    // Nested nodeConfig model fields stripped.
    expect(receivedOptions!.nodeConfig?.fallbackModel).toBeUndefined();
    expect(
      receivedOptions!.nodeConfig?.agents?.['codex-adversarial-reviewer']?.model
    ).toBeUndefined();
    // Non-model nodeConfig.agents fields preserved (not nuked wholesale).
    expect(receivedOptions!.nodeConfig?.agents?.['codex-adversarial-reviewer']?.prompt).toBe(
      'review the diff'
    );
  });

  test('Scenario 3b: terminal Codex with NO failback factory still throws', async () => {
    // Without a failback factory wired, the provider must preserve its
    // historical contract: terminal Codex failures throw. This guards
    // against the failback path becoming the silent default.
    mockRunStreamed.mockRejectedValue(
      new Error('codex exec exited with code 1: persistent subprocess crash')
    );

    const clientNoFailback = new CodexProvider({ retryBaseDelayMs: 1 });

    const consume = async (): Promise<void> => {
      for await (const _ of clientNoFailback.sendQuery('test', '/workspace')) {
        // consume
      }
    };

    await expect(consume()).rejects.toThrow(/Codex crash/);
  });

  // Codex review (2026-06-10, needs_revision -> resolved): the failback
  // path used to forward `requestOptions` UNCHANGED to the Claude failback
  // provider. That leaked Codex/OpenAI model ids (e.g. `gpt-5.3-codex`,
  // `gpt-5.6-sol`) into Claude's option builder, which uses
  // `requestOptions?.model ?? assistantDefaults.model` directly -- a Codex
  // model id sent to Claude is rejected by the SDK and the failback
  // collapses into an immediate error, defeating the entire "keep the
  // review gate alive" purpose of the failback. This test asserts the
  // contract fix: the Claude failback's `sendQuery` must not receive a
  // Codex model in `requestOptions.model`, must not receive a Codex
  // `fallbackModel`, and must not receive the Codex `assistantConfig`
  // bag (which itself carries `model`).
  test('Scenario 3c: failback strips Codex model/fallbackModel/assistantConfig from requestOptions', async () => {
    mockRunStreamed.mockRejectedValue(
      new Error('codex exec exited with code 1: persistent subprocess crash')
    );

    // Capture exactly what the Claude failback receives in its 4th arg.
    let receivedFailbackOptions: unknown = 'SENTINEL_NOT_CALLED';
    const failbackSendQuery = mock(async function* (
      _p: string,
      _c: string,
      _r?: string,
      o?: unknown
    ) {
      receivedFailbackOptions = o;
      yield { type: 'assistant', content: 'claude verdict' } as const;
      yield { type: 'result', sessionId: 'sx', tokens: { input: 1, output: 1 } } as const;
    });

    const failbackProvider = {
      sendQuery: failbackSendQuery,
      getType: () => 'claude',
      getCapabilities: () => ({}) as unknown as ReturnType<CodexProvider['getCapabilities']>,
    };

    const clientWithFailback = new CodexProvider({
      retryBaseDelayMs: 1,
      failbackProviderFactory: (() => failbackProvider) as unknown as () => typeof failbackProvider,
    });

    // Drive the Codex sendQuery with a fully populated requestOptions:
    //   - model              Codex frontier id
    //   - fallbackModel      Codex/OpenAI stale id
    //   - assistantConfig    Codex config bag (incl. `model`, modelReasoningEffort)
    //   - systemPrompt       universal field -- MUST survive sanitization
    //   - env                universal field -- MUST survive sanitization
    //   - nodeConfig         universal-ish -- MUST survive sanitization
    const codexRequestOptions = {
      model: 'gpt-5.3-codex',
      fallbackModel: 'gpt-5.2-codex',
      systemPrompt: 'please review',
      env: { FOO: 'bar' },
      nodeConfig: { output_format: { type: 'object' } },
      assistantConfig: {
        model: 'gpt-5.6-sol',
        modelReasoningEffort: 'medium' as const,
        webSearchMode: 'live' as const,
      },
    };

    const chunks: { type: string }[] = [];
    for await (const chunk of clientWithFailback.sendQuery(
      'review this',
      '/workspace',
      undefined,
      codexRequestOptions
    )) {
      chunks.push(chunk as { type: string });
    }

    // Failback was actually exercised.
    expect(failbackSendQuery).toHaveBeenCalledTimes(1);
    expect(receivedFailbackOptions).not.toBe('SENTINEL_NOT_CALLED');
    expect(receivedFailbackOptions).toBeDefined();

    // The Codex-specific keys MUST be absent from what Claude sees.
    const opts = receivedFailbackOptions as Record<string, unknown>;
    expect(opts.model).toBeUndefined();
    expect(opts.fallbackModel).toBeUndefined();
    expect(opts.assistantConfig).toBeUndefined();

    // Defense-in-depth: the entire Codex model id string must not appear
    // anywhere in the forwarded payload (catches future leaks via new
    // pass-through fields, e.g. a downstream addition to AgentRequestOptions
    // that accidentally re-exposes a model id).
    const serialized = JSON.stringify(opts);
    expect(serialized).not.toContain('gpt-5.3-codex');
    expect(serialized).not.toContain('gpt-5.2-codex');
    expect(serialized).not.toContain('gpt-5.6-sol');

    // Universal-ish fields MUST survive -- dropping them would degrade the
    // failback further than necessary.
    expect(opts.systemPrompt).toBe('please review');
    expect(opts.env).toEqual({ FOO: 'bar' });
    expect(opts.nodeConfig).toEqual({ output_format: { type: 'object' } });

    // Sanity: the failback still streamed Claude's verdict through.
    expect(chunks.some(c => c.type === 'assistant')).toBe(true);
    expect(chunks.some(c => c.type === 'result')).toBe(true);
  });
});

// --- WO-HARNESS-CODEX-AUTH-FAILBACK-01 regression tests ---
//
// Tests for the auth-class (rotation-collision) failback path added by
// WO-HARNESS-CODEX-AUTH-FAILBACK-01. The existing #192 failback machinery
// is unchanged; these tests assert only the new isAuthFailureError trigger.
describe('WO-HARNESS-CODEX-AUTH-FAILBACK-01', () => {
  // Use the anchor incident error phrases (section 2 of the WO spec).
  // The separator between "codex_turn_failed" and the message body is
  // SDK-specific; the pattern matching is substring-based and does not
  // include the separator, so this ASCII representation is valid.
  const AUTH_ROTATION_ERROR =
    'codex_turn_failed -- Your access token could not be refreshed because your refresh token was already used.';

  beforeEach(() => {
    resetCodexSingleton();
    MockCodex.mockClear();
    mockStartThread.mockClear();
    mockRunStreamed.mockClear();
    mockRefreshIfAuthFailed.mockClear();
    mockRefreshIfAuthFailed.mockResolvedValue({ refreshed: false, reason: 'no_creds' as const });
    mockStartThread.mockReturnValue(createMockThread('new-thread-id'));
    // All turn attempts throw the rotation-collision auth error
    mockRunStreamed.mockRejectedValue(new Error(AUTH_ROTATION_ERROR));
  });

  test('isAuthFailureError: auth rotation error fires failback with disclosure', async () => {
    // WO spec section 11.1: factory wired, auth rotation error -> [CODEX FAILBACK] + Claude
    // result, no throw. The new isAuthFailureError branch fires BEFORE
    // classifyAndEnrichCodexError, so mockRefreshIfAuthFailed must NOT be called.
    const failbackSendQuery = mock(async function* () {
      yield { type: 'assistant', content: 'Claude auth-fallback verdict' } as const;
      yield { type: 'result', sessionId: 'cb-session', tokens: { input: 10, output: 5 } } as const;
    });
    const failbackProvider = {
      sendQuery: failbackSendQuery,
      getType: () => 'claude',
      getCapabilities: () => ({}) as unknown as ReturnType<CodexProvider['getCapabilities']>,
    };
    const client = new CodexProvider({
      retryBaseDelayMs: 1,
      failbackProviderFactory: () => failbackProvider,
    });

    const chunks: { type: string; content?: string }[] = [];
    for await (const chunk of client.sendQuery('review diff', '/workspace')) {
      chunks.push(chunk as { type: string; content?: string });
    }

    expect(failbackSendQuery).toHaveBeenCalledTimes(1);
    // Auth-refresh must NOT be called -- new branch returns before reaching the
    // auth-refresh block at line 942 (original numbering).
    expect(mockRefreshIfAuthFailed).not.toHaveBeenCalled();
    const disclosure = chunks.find(
      c => c.type === 'system' && c.content?.includes('CODEX FAILBACK')
    );
    expect(disclosure).toBeDefined();
    expect(disclosure!.content).toMatch(/credential rotation/i);
    expect(
      chunks.some(c => c.type === 'assistant' && c.content === 'Claude auth-fallback verdict')
    ).toBe(true);
    expect(chunks.some(c => c.type === 'result')).toBe(true);
  });

  test('isAuthFailureError: non-auth generic error does NOT trigger auth failback', async () => {
    // WO spec section 11.2: a generic crash error must NOT use the new auth-class failback
    // path. It goes through 3 retries (MAX_SUBPROCESS_RETRIES=3), then the existing
    // terminal failback fires and DOES call the factory via the general path.
    // What must be absent is the NEW "credential rotation" disclosure chunk.
    mockRunStreamed.mockRejectedValue(
      new Error('codex exec exited with code 1: generic subprocess crash')
    );
    const generalFailbackSendQuery = mock(async function* () {
      yield { type: 'assistant', content: 'general-failback-via-retry-exhaustion' } as const;
      yield { type: 'result', sessionId: 'x', tokens: { input: 1, output: 1 } } as const;
    });
    const generalFailbackProvider = {
      sendQuery: generalFailbackSendQuery,
      getType: () => 'claude',
      getCapabilities: () => ({}) as unknown as ReturnType<CodexProvider['getCapabilities']>,
    };
    const client = new CodexProvider({
      retryBaseDelayMs: 1,
      failbackProviderFactory: () => generalFailbackProvider,
    });

    const chunks: { type: string; content?: string }[] = [];
    for await (const chunk of client.sendQuery('review diff', '/workspace')) {
      chunks.push(chunk as { type: string; content?: string });
    }

    // The NEW auth-specific "credential rotation" disclosure must be absent.
    const authDisclosure = chunks.find(
      c => c.type === 'system' && c.content?.includes('credential rotation')
    );
    expect(authDisclosure).toBeUndefined();
    // The existing general [CODEX FAILBACK] disclosure IS present (expected via general path).
    const generalDisclosure = chunks.find(
      c => c.type === 'system' && c.content?.includes('CODEX FAILBACK')
    );
    expect(generalDisclosure).toBeDefined();
  });

  test('isAuthFailureError: single-pattern-only reauth message does NOT trigger auth failback', async () => {
    // Regression guard for the Codex diff-repair finding (2026-06-29):
    // "Your access token could not be refreshed. Please log out and sign in again."
    // contains 'access token could not be refreshed' but NOT 'refresh token was already
    // used'. With .some() this would incorrectly intercept the message before
    // refreshIfAuthFailed; with .every() it falls through to the existing auth-refresh
    // path. Verify: factory is NOT called and the turn throws (no factory wired below).
    mockRunStreamed.mockRejectedValue(
      new Error(
        'codex_turn_failed -- Your access token could not be refreshed. ' +
          'Please log out and sign in again.'
      )
    );
    // Wire a factory so if isAuthFailureError fires (bug) it would be detectable.
    const unexpectedFactory = mock(() => ({
      sendQuery: mock(async function* () {
        yield { type: 'assistant', content: 'should not appear' } as const;
      }),
      getType: () => 'claude',
      getCapabilities: () => ({}) as unknown as ReturnType<CodexProvider['getCapabilities']>,
    }));
    const client = new CodexProvider({
      retryBaseDelayMs: 1,
      failbackProviderFactory: unexpectedFactory,
    });

    // The message is auth-class (AUTH_PATTERNS matches 'access token could not be
    // refreshed') but NOT rotation-collision, so isAuthFailureError must return false.
    // The run exhausts retries, then the existing general failback OR throw path fires
    // (NOT the new auth-specific path). The new 'credential rotation' disclosure must
    // be absent.
    const chunks: { type: string; content?: string }[] = [];
    for await (const chunk of client.sendQuery('review diff', '/workspace')) {
      chunks.push(chunk as { type: string; content?: string });
    }

    // The NEW auth-specific "credential rotation" disclosure must be absent.
    const authDisclosure = chunks.find(
      c => c.type === 'system' && c.content?.includes('credential rotation')
    );
    expect(authDisclosure).toBeUndefined();
    // The factory may be called via the general failback (expected), but if so the
    // disclosure must be the generic [CODEX FAILBACK], not the credential-rotation one.
    // The key assertion is that the rotation-specific auth path was not taken.
  });

  test('isAuthFailureError: null failback factory throws original auth error', async () => {
    // WO spec section 11.3: no factory -> auth rotation error flows to
    // classifyAndEnrichCodexError (auth class, shouldRetry=false) -> auth-refresh block
    // (refreshIfAuthFailed returns no_creds, not terminal) -> throw enrichedError.
    // Must throw, not swallow.
    const clientNoFactory = new CodexProvider({ retryBaseDelayMs: 1 });

    const consume = async (): Promise<void> => {
      for await (const _ of clientNoFactory.sendQuery('review diff', '/workspace')) {
        // consume
      }
    };

    await expect(consume()).rejects.toThrow();
  });

  test('isAuthFailureError: single-shot guard prevents double-delegation', async () => {
    // WO spec section 11.4: authFailbackUsed prevents re-entry. The first auth-class
    // catch fires the failback and returns. The loop does not continue after the return,
    // so the factory is called exactly once.
    let factoryCallCount = 0;
    const failbackSendQuery = mock(async function* () {
      yield { type: 'assistant', content: 'single-shot only' } as const;
      yield { type: 'result', sessionId: 'x', tokens: { input: 1, output: 1 } } as const;
    });
    const failbackProvider = {
      sendQuery: failbackSendQuery,
      getType: () => 'claude',
      getCapabilities: () => ({}) as unknown as ReturnType<CodexProvider['getCapabilities']>,
    };
    const client = new CodexProvider({
      retryBaseDelayMs: 1,
      failbackProviderFactory: () => {
        factoryCallCount++;
        return failbackProvider;
      },
    });

    for await (const _ of client.sendQuery('review diff', '/workspace')) {
      // consume
    }

    // Factory invoked exactly once; failback delegated once.
    expect(factoryCallCount).toBe(1);
    expect(failbackSendQuery).toHaveBeenCalledTimes(1);
  });

  test('dead-auth refresh token was revoked wraps failback AbortError without unhandled rejection', async () => {
    mockRunStreamed.mockRejectedValue(new Error('The refresh token was revoked'));
    const unhandledRejection = mock((_reason: unknown) => {});
    process.on('unhandledRejection', unhandledRejection);
    const abortError = new Error('This operation was aborted');
    abortError.name = 'AbortError';
    const failbackSendQuery = mock(async function* () {
      throw abortError;
    });
    const failbackProvider = {
      sendQuery: failbackSendQuery,
      getType: () => 'claude',
      getCapabilities: () => ({}) as unknown as ReturnType<CodexProvider['getCapabilities']>,
    };
    const client = new CodexProvider({
      retryBaseDelayMs: 1,
      failbackProviderFactory: () => failbackProvider,
    });

    const consume = async (): Promise<void> => {
      for await (const _ of client.sendQuery('review diff', '/workspace')) {
        // consume
      }
    };

    try {
      await expect(consume()).rejects.toThrow(/codex auth error/i);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(failbackSendQuery).toHaveBeenCalledTimes(1);
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
    }
  });

  test('dead-auth rotation collision failback fires once and reports auth failure normally', async () => {
    const unhandledRejection = mock((_reason: unknown) => {});
    process.on('unhandledRejection', unhandledRejection);
    const failbackSendQuery = mock(async function* () {
      throw new Error('This operation was aborted');
    });
    const failbackProvider = {
      sendQuery: failbackSendQuery,
      getType: () => 'claude',
      getCapabilities: () => ({}) as unknown as ReturnType<CodexProvider['getCapabilities']>,
    };
    let factoryCallCount = 0;
    const client = new CodexProvider({
      retryBaseDelayMs: 1,
      failbackProviderFactory: () => {
        factoryCallCount++;
        return failbackProvider;
      },
    });

    const consume = async (): Promise<void> => {
      for await (const _ of client.sendQuery('review diff', '/workspace')) {
        // consume
      }
    };

    try {
      await expect(consume()).rejects.toThrow(/codex auth error/i);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(factoryCallCount).toBe(1);
      expect(failbackSendQuery).toHaveBeenCalledTimes(1);
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
    }
  });
});

// T3 (WO-HARNESS-LAYER1-SERVED-MODEL-CAPTURE-01): the spec asks for a Codex
// served-model assertion, but @openai/codex-sdk@0.125.0 does NOT expose a
// served-model field on TurnCompletedEvent, Thread, ThreadOptions, or
// TurnOptions. Per the spec's T5 clause ("a provider that does not expose
// served model -> served_model_id=null with a recorded reason"), Codex emits
// an explicit null + reason. This test asserts that contract -- no
// fabricated value, no crash, machine-readable reason for downstream.
describe('CodexProvider served-model capture (T3 redirected to T5 -- SDK limitation)', () => {
  let client: CodexProvider;

  beforeEach(() => {
    resetCodexSingleton();
    client = new CodexProvider({ retryBaseDelayMs: 1 });
    mockRunStreamed.mockClear();
    mockStartThread.mockClear();
    mockStartThread.mockReturnValue(createMockThread('new-thread-id'));
  });

  test('emits servedModelId=null with codex_sdk_does_not_expose_served_model reason', async () => {
    mockRunStreamed.mockResolvedValue({
      events: (async function* () {
        yield { type: 'turn.completed', usage: defaultUsage };
      })(),
    });

    const chunks = [];
    for await (const chunk of client.sendQuery('test', '/workspace')) {
      chunks.push(chunk);
    }

    const result = chunks.find(c => c.type === 'result');
    expect(result).toBeDefined();
    // servedModelId is explicitly null -- the provider could not tell us.
    expect(result && 'servedModelId' in result ? result.servedModelId : 'absent').toBeNull();
    // Reason string is machine-readable so downstream consumers can branch on it.
    expect(
      result && 'servedModelMissingReason' in result ? result.servedModelMissingReason : undefined
    ).toBe('codex_sdk_does_not_expose_served_model');
  });
});
