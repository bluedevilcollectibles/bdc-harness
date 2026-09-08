import { mkdtemp, readdir, realpath, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import { PROMPT_FILE_PLACEHOLDER, type AgentConfig } from './adapters';
import { resolveAgentCwd, runAgent } from './index';

/**
 * John's directive 2026-09-08: board seats must get context. These tests pin
 * the two halves of that -- the config field resolves the way the README
 * promises, and the exec transport actually spawns the child in the resolved
 * directory.
 */

function message(body: string, recipient: string) {
  return {
    id: `agent-cwd-test-${recipient}-${Date.now()}`,
    task_type: 'agent_message' as const,
    sender: 'test',
    recipient,
    body,
    status: 'claimed' as const,
    fencing_token: 1,
  };
}

/** A child that prints its own working directory, so the spawn cwd is observable. */
async function printCwdConfig(extra: Partial<AgentConfig> = {}): Promise<AgentConfig> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-cwd-print-'));
  const script = join(dir, 'print-cwd.cjs');
  await writeFile(script, 'process.stdout.write(process.cwd());\n', 'utf8');
  return { command: process.execPath, args: [script], ...extra };
}

describe('per-agent cwd config parsing', () => {
  test('an existing configured directory is used verbatim', async () => {
    const configured = await mkdtemp(join(tmpdir(), 'agent-cwd-configured-'));
    const resolved = await resolveAgentCwd(
      { command: 'noop', args: [], cwd: configured },
      'agent-cwd-unused-'
    );

    expect(resolved.cwd).toBe(configured);
    expect(resolved.source).toBe('configured');
    expect(resolved.warning).toBeUndefined();
  });

  test('an unset cwd falls back to a fresh temp directory', async () => {
    const first = await resolveAgentCwd({ command: 'noop', args: [] }, 'agent-cwd-unset-');
    const second = await resolveAgentCwd({ command: 'noop', args: [] }, 'agent-cwd-unset-');

    expect(first.source).toBe('temp');
    expect(second.source).toBe('temp');
    expect(first.warning).toBeUndefined();
    expect(first.cwd).toContain('agent-cwd-unset-');
    // A scratch directory per dispatch, not one shared across runs.
    expect(first.cwd).not.toBe(second.cwd);
  });

  test('a missing configured directory warns and falls back to temp', async () => {
    const missing = join(tmpdir(), `agent-cwd-missing-${Date.now()}`, 'no-such-checkout');
    const resolved = await resolveAgentCwd(
      { command: 'noop', args: [], cwd: missing },
      'agent-cwd-missing-fallback-'
    );

    expect(resolved.source).toBe('temp');
    expect(resolved.cwd).not.toBe(missing);
    expect(resolved.cwd).toContain('agent-cwd-missing-fallback-');
    expect(resolved.warning).toContain(missing);
  });

  test('a relative configured cwd is rejected and falls back to temp', async () => {
    const resolved = await resolveAgentCwd(
      { command: 'noop', args: [], cwd: './relative-checkout' },
      'agent-cwd-relative-'
    );

    expect(resolved.source).toBe('temp');
    expect(resolved.warning).toContain('absolute');
  });
});

/** Raw child stdout, which runAgent persists as `text` when persistReplyText is on. */
function childStdout(resultBody: string): string {
  return JSON.parse(resultBody).text as string;
}

describe('exec path honours the configured cwd', () => {
  test('the child process runs in the configured directory', async () => {
    const configured = await mkdtemp(join(tmpdir(), 'agent-cwd-exec-'));
    const config = await printCwdConfig({ cwd: configured });

    const result = await runAgent(config, message('where are you', 'codex'), undefined, true);

    expect(result.status).toBe('done');
    // realpath because macOS resolves /var -> /private/var under mkdtemp.
    expect(await realpath(childStdout(result.resultBody))).toBe(await realpath(configured));
  }, 15_000);

  test('a configured cwd is never written into by the worker', async () => {
    // prompt-file seats write dispatch-prompt.txt; it must land in scratch, not
    // in the real checkout the seat was pointed at.
    const configured = await mkdtemp(join(tmpdir(), 'agent-cwd-nowrite-'));
    const scriptDir = await mkdtemp(join(tmpdir(), 'agent-cwd-nowrite-script-'));
    const script = join(scriptDir, 'echo-prompt-file-arg.cjs');
    await writeFile(
      script,
      "const fs = require('fs');\nconst path = process.argv[3];\nprocess.stdout.write(fs.readFileSync(path, 'utf8'));\n",
      'utf8'
    );
    const config: AgentConfig = {
      command: process.execPath,
      args: [script, '--prompt-file', PROMPT_FILE_PLACEHOLDER],
      promptDelivery: 'prompt-file',
      cwd: configured,
    };

    const result = await runAgent(config, message('prompt body', 'grok'));

    expect(result.status).toBe('done');
    expect(await readdir(configured)).toEqual([]);
  }, 15_000);

  test('an unset cwd still spawns in a per-dispatch temp directory', async () => {
    const config = await printCwdConfig();
    const result = await runAgent(config, message('where are you', 'claude'), undefined, true);

    expect(result.status).toBe('done');
    const childCwd = childStdout(result.resultBody);
    expect(childCwd).toContain('bdc-dispatch-claude-');
    expect(await realpath(childCwd)).toStartWith(await realpath(tmpdir()));
  }, 15_000);
});

describe('per-agent env config', () => {
  test('configured env reaches the child process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-env-'));
    const script = join(dir, 'print-env.cjs');
    await writeFile(
      script,
      "process.stdout.write(process.env.BDC_TEST_SEAT_VAR ?? 'unset');\n",
      'utf8'
    );
    const config: AgentConfig = {
      command: process.execPath,
      args: [script],
      env: { BDC_TEST_SEAT_VAR: 'oracle-url-here' },
    };

    const result = await runAgent(config, message('env check', 'codex'), undefined, true);

    expect(result.status).toBe('done');
    expect(childStdout(result.resultBody)).toBe('oracle-url-here');
  }, 15_000);

  test('an unset env leaves the child on the worker environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-env-unset-'));
    const script = join(dir, 'print-env.cjs');
    await writeFile(
      script,
      "process.stdout.write(process.env.BDC_TEST_SEAT_VAR ?? 'unset');\n",
      'utf8'
    );
    const config: AgentConfig = { command: process.execPath, args: [script] };

    const result = await runAgent(config, message('env check', 'claude'), undefined, true);

    expect(result.status).toBe('done');
    expect(childStdout(result.resultBody)).toBe('unset');
  }, 15_000);
});
