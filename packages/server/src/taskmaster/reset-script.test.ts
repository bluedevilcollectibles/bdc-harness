import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bash =
  process.platform === 'win32'
    ? join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe')
    : 'bash';
const script = fileURLToPath(
  new URL('../../../../scripts/taskmaster/reset.sh', import.meta.url)
).replaceAll('\\', '/');

async function runReset(args: string[], token = 'synthetic-reset-test') {
  // Replace only the network boundary. The shipped shell script builds the payload.
  const child = Bun.spawn(
    [
      bash,
      '-c',
      'curl() { while [ "$#" -gt 0 ]; do if [ "$1" = "--data" ]; then printf "%s" "$2"; return 0; fi; shift; done; return 97; }; export -f curl; bash "$@"',
      'reset-script-test',
      script,
      ...args,
    ],
    {
      env: { ...process.env, ARCHON_OPERATOR_TOKEN: token },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test('reset payload round-trips quotes, backslashes and every non-NUL control character', async () => {
  const actor = 'operator"\\\t\r\n';
  const reason =
    'caf\u00e9 ' + Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1)).join('') + '\n';
  const result = await runReset(['--confirm', '--actor', actor, '--reason', reason]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ actor, reason });
}, 15_000);

test('reset dry run needs no token and does not call the network boundary', async () => {
  const result = await runReset([], '');
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('[dry-run]');
  expect(result.stdout).not.toContain('{"actor"');
}, 15_000);
