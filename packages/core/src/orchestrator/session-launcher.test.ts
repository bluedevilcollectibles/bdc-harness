import { mock, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, symlink, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMockLogger } from '../test/mocks/logger';
import { MockPlatformAdapter } from '../test/mocks/platform';
import type { Conversation, Codebase } from '../types';

// --- Mock setup (BEFORE importing module under test) -------------------------

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// The launcher delegates entirely to validateAndResolveIsolation. Mock it so
// tests control the resolution outcome (success / block / resolved-to-primary).
const mockValidateAndResolveIsolation = mock(
  (..._args: unknown[]): Promise<{ status: string; cwd: string }> =>
    Promise.resolve({ status: 'new', cwd: '/worktrees/session-1' })
);
mock.module('./orchestrator', () => ({
  validateAndResolveIsolation: mockValidateAndResolveIsolation,
  dispatchBackgroundWorkflow: mock(() => Promise.resolve()),
}));

// Real IsolationBlockedError shape (instanceof check in the launcher).
class MockIsolationBlockedError extends Error {
  constructor(
    message: string,
    public reason?: string
  ) {
    super(message);
    this.name = 'IsolationBlockedError';
  }
}
mock.module('@archon/isolation', () => ({
  IsolationBlockedError: MockIsolationBlockedError,
}));

// --- Import module under test AFTER all mocks --------------------------------

const { launchSession } = await import('./session-launcher');

// --- Test helpers ------------------------------------------------------------

function makeConversation(overrides?: Partial<Conversation>): Conversation {
  return {
    id: 'conv-1',
    platform_type: 'web',
    platform_conversation_id: 'web-conv-1',
    codebase_id: 'cb-1',
    cwd: null,
    isolation_env_id: null,
    ai_assistant_type: 'claude',
    title: null,
    hidden: false,
    deleted_at: null,
    last_activity_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeCodebase(overrides?: Partial<Codebase>): Codebase {
  return {
    id: 'cb-1',
    name: 'test-repo',
    repository_url: null,
    default_cwd: '/repos/test-repo',
    ai_assistant_type: 'claude',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// --- Tests -------------------------------------------------------------------

describe('launchSession', () => {
  let platform: MockPlatformAdapter;

  beforeEach(() => {
    platform = new MockPlatformAdapter();
    mockValidateAndResolveIsolation.mockClear();
    mockValidateAndResolveIsolation.mockImplementation(() =>
      Promise.resolve({ status: 'new', cwd: '/worktrees/session-1' })
    );
  });

  // Scenario 1: Allocation -- starting a session allocates a worktree cwd.
  test('allocates a worktree and returns it as the session cwd', async () => {
    const conversation = makeConversation();
    const codebase = makeCodebase();

    const result = await launchSession(conversation, codebase, platform, 'web-conv-1');

    expect(result.refused).toBe(false);
    if (!result.refused) {
      expect(result.cwd).toBe('/worktrees/session-1');
    }
    // Keyed on the stable conversation id, as a per-session 'thread' request.
    expect(mockValidateAndResolveIsolation).toHaveBeenCalledTimes(1);
    const hints = mockValidateAndResolveIsolation.mock.calls[0][4] as {
      workflowType: string;
      workflowId: string;
    };
    expect(hints).toEqual({ workflowType: 'thread', workflowId: 'conv-1' });
  });

  // Scenario 2: Reuse -- same conversation id resolves via the same key.
  test('reuses the same isolation key across repeated launches (reconnect)', async () => {
    const conversation = makeConversation({ id: 'conv-reuse' });
    const codebase = makeCodebase();

    mockValidateAndResolveIsolation.mockImplementation(() =>
      Promise.resolve({ status: 'existing', cwd: '/worktrees/reuse' })
    );

    const first = await launchSession(conversation, codebase, platform, 'web-conv-1');
    const second = await launchSession(conversation, codebase, platform, 'web-conv-1');

    expect(first).toEqual({ refused: false, cwd: '/worktrees/reuse' });
    expect(second).toEqual({ refused: false, cwd: '/worktrees/reuse' });
    const key1 = mockValidateAndResolveIsolation.mock.calls[0][4] as { workflowId: string };
    const key2 = mockValidateAndResolveIsolation.mock.calls[1][4] as { workflowId: string };
    expect(key1.workflowId).toBe('conv-reuse');
    expect(key2.workflowId).toBe(key1.workflowId);
  });

  // Scenario 3, case A: creation failed -> IsolationBlockedError -> fail closed.
  test('refuses (fail closed) with a "primary checkout" message when isolation is blocked', async () => {
    const conversation = makeConversation();
    const codebase = makeCodebase();

    mockValidateAndResolveIsolation.mockImplementation(() =>
      Promise.reject(new MockIsolationBlockedError('blocked', 'creation_failed'))
    );

    const result = await launchSession(conversation, codebase, platform, 'web-conv-1');

    expect(result.refused).toBe(true);
    if (result.refused) {
      expect(result.message).toContain('primary checkout');
      expect(result.message).toContain('test-repo');
    }
    // No cwd is ever returned on refusal (nothing to fall through to).
    expect(result).not.toHaveProperty('cwd');
  });

  // Scenario 3, case B: defense-in-depth -- resolved cwd equals the primary checkout.
  test('refuses when the resolved cwd is the shared primary checkout', async () => {
    const conversation = makeConversation();
    const codebase = makeCodebase({ default_cwd: '/repos/test-repo' });

    // Resolver (contract-violating) hands back the primary checkout itself.
    mockValidateAndResolveIsolation.mockImplementation(() =>
      Promise.resolve({ status: 'new', cwd: '/repos/test-repo' })
    );

    const result = await launchSession(conversation, codebase, platform, 'web-conv-1');

    expect(result.refused).toBe(true);
    if (result.refused) {
      expect(result.message).toContain('primary checkout');
      expect(result.message).toContain('/repos/test-repo');
    }
  });

  // Scenario 3, case B (alias): the resolver hands back a SYMLINK alias that
  // resolves to the primary checkout. A lexical string compare would treat the
  // alias path and the primary path as different and let the session run in the
  // shared clone; filesystem-identity comparison (realpath) must catch it.
  describe('filesystem-identity guard (Case B aliases)', () => {
    let realDir: string;

    beforeEach(async () => {
      realDir = await mkdtemp(join(tmpdir(), 'session-launcher-alias-'));
    });

    afterEach(async () => {
      await rm(realDir, { recursive: true, force: true });
    });

    test('refuses when the resolved cwd is a symlink alias of the primary checkout', async () => {
      const primary = join(realDir, 'primary-checkout');
      const alias = join(realDir, 'primary-alias');
      await mkdir(primary, { recursive: true });
      // Alias -> primary; realpath(alias) === realpath(primary).
      await symlink(primary, alias, process.platform === 'win32' ? 'junction' : 'dir');

      const conversation = makeConversation();
      const codebase = makeCodebase({ default_cwd: primary });

      // Resolver (contract-violating) returns the alias, which is really primary.
      mockValidateAndResolveIsolation.mockImplementation(() =>
        Promise.resolve({ status: 'new', cwd: alias })
      );

      const result = await launchSession(conversation, codebase, platform, 'web-conv-1');

      expect(result.refused).toBe(true);
      if (result.refused) {
        expect(result.message).toContain('primary checkout');
        expect(result.message).toContain(primary);
      }
    });

    test('allows a genuinely distinct worktree that is not an alias of the primary', async () => {
      const primary = join(realDir, 'primary-checkout');
      const worktree = join(realDir, 'worktree-1');
      await mkdir(primary, { recursive: true });
      await mkdir(worktree, { recursive: true });

      const conversation = makeConversation();
      const codebase = makeCodebase({ default_cwd: primary });

      mockValidateAndResolveIsolation.mockImplementation(() =>
        Promise.resolve({ status: 'new', cwd: worktree })
      );

      const result = await launchSession(conversation, codebase, platform, 'web-conv-1');

      expect(result.refused).toBe(false);
      if (!result.refused) {
        expect(result.cwd).toBe(worktree);
      }
    });

    // Case-insensitive-filesystem guard. On win32 a differently cased spelling
    // of the same directory is the SAME directory, so it must be refused. On
    // case-sensitive filesystems (Linux CI) the two are genuinely distinct
    // directories, so this assertion is win32-only.
    test.if(process.platform === 'win32')(
      'refuses when the resolved cwd differs only by case from the primary checkout',
      async () => {
        const primary = join(realDir, 'PrimaryCheckout');
        await mkdir(primary, { recursive: true });
        const casedAlias = join(realDir, 'primarycheckout');

        const conversation = makeConversation();
        const codebase = makeCodebase({ default_cwd: primary });

        mockValidateAndResolveIsolation.mockImplementation(() =>
          Promise.resolve({ status: 'new', cwd: casedAlias })
        );

        const result = await launchSession(conversation, codebase, platform, 'web-conv-1');

        expect(result.refused).toBe(true);
      },
      15000
    );
  });

  // Scenario 4: Concurrency -- two distinct sessions pass distinct keys and get
  // distinct worktrees. (This verifies OUR code forwards distinct keys; the
  // resolver's own concurrency guarantees are tested in packages/isolation.)
  test('two concurrent sessions receive distinct worktrees keyed by conversation id', async () => {
    const convA = makeConversation({ id: 'conv-A' });
    const convB = makeConversation({ id: 'conv-B' });
    const codebase = makeCodebase();

    mockValidateAndResolveIsolation.mockImplementation((..._args: unknown[]) => {
      const hints = _args[4] as { workflowId: string };
      return Promise.resolve({ status: 'new', cwd: `/worktrees/${hints.workflowId}` });
    });

    const [resultA, resultB] = await Promise.all([
      launchSession(convA, codebase, platform, 'web-conv-A'),
      launchSession(convB, codebase, platform, 'web-conv-B'),
    ]);

    expect(resultA).toEqual({ refused: false, cwd: '/worktrees/conv-A' });
    expect(resultB).toEqual({ refused: false, cwd: '/worktrees/conv-B' });
    if (!resultA.refused && !resultB.refused) {
      expect(resultA.cwd).not.toBe(resultB.cwd);
    }
  });

  // A non-IsolationBlockedError propagates (fail fast -- not swallowed).
  test('re-throws non-isolation errors instead of masking them as refusals', async () => {
    const conversation = makeConversation();
    const codebase = makeCodebase();

    mockValidateAndResolveIsolation.mockImplementation(() =>
      Promise.reject(new Error('database exploded'))
    );

    await expect(launchSession(conversation, codebase, platform, 'web-conv-1')).rejects.toThrow(
      'database exploded'
    );
  });
});
