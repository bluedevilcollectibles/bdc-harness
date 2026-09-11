import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
export interface RunnerHeartbeat {
  readonly observedAt: string;
  readonly suiteRunId: string;
}
export async function writeRunnerHeartbeat(
  outputRoot: string,
  heartbeat: RunnerHeartbeat
): Promise<string> {
  const path = join(outputRoot, 'mechanisms-heartbeat.json');
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(heartbeat, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, path);
  return path;
}
export async function checkRunnerLiveness(
  path: string,
  maxAgeMs: number,
  now = Date.now()
): Promise<{ healthy: boolean; reasonCode?: string }> {
  try {
    const heartbeat = JSON.parse(await readFile(path, 'utf8')) as RunnerHeartbeat;
    const age = now - Date.parse(heartbeat.observedAt);
    return Number.isFinite(age) && age <= maxAgeMs
      ? { healthy: true }
      : { healthy: false, reasonCode: 'mechanism_runner_heartbeat_stale' };
  } catch {
    return { healthy: false, reasonCode: 'mechanism_runner_heartbeat_missing' };
  }
}
