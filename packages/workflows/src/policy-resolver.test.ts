import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

// Inline mock logger so the resolver's createLogger() does not spam test output.
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function () {
    return mockLogger;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};

const realArchonPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realArchonPaths,
  createLogger: mock(() => mockLogger),
}));

import { resolveWorkflowPolicyFile } from './policy-resolver';
import {
  BUNDLED_AGENT_BEHAVIOR_POLICY,
  BUNDLED_AGENT_BEHAVIOR_POLICY_PATH,
  BUNDLED_AGENT_BEHAVIOR_POLICY_SHA256,
} from './defaults/bundled-policy.generated';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

describe('resolveWorkflowPolicyFile', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `policy-resolver-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
    mockLogger.warn.mockClear();
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('returns bundled canonical when local file is absent and path is canonical', async () => {
    const result = await resolveWorkflowPolicyFile(BUNDLED_AGENT_BEHAVIOR_POLICY_PATH, testDir);
    expect(result.source).toBe('bundled');
    expect(result.content).toBe(BUNDLED_AGENT_BEHAVIOR_POLICY);
    expect(result.resolvedPath).toBeUndefined();
  });

  it('returns local source when local file matches bundled SHA256', async () => {
    const localPath = join(testDir, 'harness', 'policies');
    await mkdir(localPath, { recursive: true });
    await writeFile(join(localPath, 'agent-behavior.md'), BUNDLED_AGENT_BEHAVIOR_POLICY, 'utf-8');
    const result = await resolveWorkflowPolicyFile(BUNDLED_AGENT_BEHAVIOR_POLICY_PATH, testDir);
    expect(result.source).toBe('local');
    expect(result.content).toBe(BUNDLED_AGENT_BEHAVIOR_POLICY);
    expect(result.resolvedPath).toBe(join(testDir, BUNDLED_AGENT_BEHAVIOR_POLICY_PATH));
  });

  it('falls back to bundled when local file at canonical path has mismatching SHA256', async () => {
    const localPath = join(testDir, 'harness', 'policies');
    await mkdir(localPath, { recursive: true });
    await writeFile(
      join(localPath, 'agent-behavior.md'),
      '# Drifted local copy that disagrees with canonical',
      'utf-8'
    );
    const result = await resolveWorkflowPolicyFile(BUNDLED_AGENT_BEHAVIOR_POLICY_PATH, testDir);
    expect(result.source).toBe('bundled');
    expect(result.content).toBe(BUNDLED_AGENT_BEHAVIOR_POLICY);
    expect(mockLogger.warn).toHaveBeenCalled();
    const warnCall = mockLogger.warn.mock.calls[0]?.[0] as
      | { policyFile?: string; localSha256?: string; bundledSha256?: string }
      | undefined;
    expect(warnCall?.policyFile).toBe(BUNDLED_AGENT_BEHAVIOR_POLICY_PATH);
    expect(warnCall?.bundledSha256).toBe(BUNDLED_AGENT_BEHAVIOR_POLICY_SHA256);
  });

  it('throws policyFile not found when local file absent and path is non-canonical', async () => {
    await expect(resolveWorkflowPolicyFile('docs/some-other-policy.md', testDir)).rejects.toThrow(
      /policyFile not found/
    );
  });

  it('throws policyFile is empty when local file exists but contains only whitespace', async () => {
    await writeFile(join(testDir, 'empty.md'), '   \n\n', 'utf-8');
    await expect(resolveWorkflowPolicyFile('empty.md', testDir)).rejects.toThrow(
      /policyFile is empty/
    );
  });

  it('honors a non-canonical local policy path with custom content', async () => {
    const customPath = 'docs/team-policy.md';
    const customDir = join(testDir, 'docs');
    await mkdir(customDir, { recursive: true });
    const customContent = '# Team-specific policy\nDo X, do Y.';
    await writeFile(join(customDir, 'team-policy.md'), customContent, 'utf-8');
    const result = await resolveWorkflowPolicyFile(customPath, testDir);
    expect(result.source).toBe('local');
    expect(result.content).toBe(customContent);
    expect(result.resolvedPath).toBe(join(testDir, customPath));
    // Custom-path local files do NOT trigger the SHA256-mismatch warning;
    // the warning is only meaningful when the declared path is canonical.
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('SHA256 of bundled canonical matches the exported constant', () => {
    expect(sha256(BUNDLED_AGENT_BEHAVIOR_POLICY)).toBe(BUNDLED_AGENT_BEHAVIOR_POLICY_SHA256);
  });

  it('bundled policy contains the four locked principles sentinel text', () => {
    expect(BUNDLED_AGENT_BEHAVIOR_POLICY).toContain('Think before building');
    expect(BUNDLED_AGENT_BEHAVIOR_POLICY).toContain('Surgical changes only');
    expect(BUNDLED_AGENT_BEHAVIOR_POLICY).toContain('Simplicity first');
    expect(BUNDLED_AGENT_BEHAVIOR_POLICY).toContain('Goal-driven execution');
  });

  it('LF-normalizes a local file written with CRLF line endings', async () => {
    const localPath = join(testDir, 'harness', 'policies');
    await mkdir(localPath, { recursive: true });
    // Write CRLF version of bundled content; after LF normalization the
    // SHA256 must match the bundled SHA256.
    const crlfContent = BUNDLED_AGENT_BEHAVIOR_POLICY.replace(/\n/g, '\r\n');
    await writeFile(join(localPath, 'agent-behavior.md'), crlfContent, 'utf-8');
    const result = await resolveWorkflowPolicyFile(BUNDLED_AGENT_BEHAVIOR_POLICY_PATH, testDir);
    expect(result.source).toBe('local');
    expect(result.content).toBe(BUNDLED_AGENT_BEHAVIOR_POLICY);
  });
});
