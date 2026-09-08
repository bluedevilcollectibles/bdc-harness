/**
 * Temp-directory teardown that tolerates Windows file-handle latency.
 *
 * On windows-latest CI, a test that creates a temp sqlite home and tears it
 * down with `closeDatabase(); resetDatabase(); rmSync(home, ...)` intermittently
 * fails with `EBUSY: resource busy or locked`. The sqlite adapter's close()
 * already checkpoints the WAL and forces `Bun.gc(true)` (see
 * `src/db/adapters/sqlite.ts`), which is enough on an idle machine. On a loaded
 * runner the OS can still hold the file handle for a few milliseconds after the
 * process has released it -- Windows deletes are asynchronous at the kernel
 * level, and antivirus/indexer scans extend the window further.
 *
 * Retrying with a short backoff clears it. On final failure we log one line and
 * return without throwing: the runner's temp directory is reaped by the OS, so a
 * leaked fixture directory is not worth failing an otherwise-green test over.
 */
import { rmSync } from 'fs';

export interface RemoveTempDirOptions {
  /** Total attempts, including the first. Defaults to 6. */
  attempts?: number;
  /** Base delay between attempts in ms; grows linearly. Defaults to 250. */
  delayMs?: number;
  /** Injection seam for tests. Defaults to `fs.rmSync`. */
  rm?: (path: string) => void;
  /** Injection seam for tests. Defaults to `Bun.sleepSync`. */
  sleep?: (ms: number) => void;
  /** Injection seam for tests. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

/** Errno codes that mean "the handle has not been released yet, try again". */
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function defaultSleep(ms: number): void {
  if (typeof Bun !== 'undefined' && typeof Bun.sleepSync === 'function') {
    Bun.sleepSync(ms);
    return;
  }
  // Node fallback: busy-wait. Only reached outside Bun, and only on a retry
  // path that is already rare, so the spin cost does not matter.
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin */
  }
}

/**
 * Remove a temp directory, retrying on Windows file-lock errors.
 *
 * Never throws. Synchronous, so it drops into an existing `afterEach` without
 * changing whether the hook is async.
 */
export function removeTempDirWithRetry(path: string, options: RemoveTempDirOptions = {}): void {
  const attempts = options.attempts ?? 6;
  const delayMs = options.delayMs ?? 250;
  const rm = options.rm ?? ((target: string) => rmSync(target, { recursive: true, force: true }));
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? ((message: string) => console.warn(message));

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rm(path);
      return;
    } catch (error) {
      lastError = error;
      const code = errorCode(error);
      if (code !== undefined && !RETRYABLE_CODES.has(code)) {
        // Not a lock-contention error (e.g. EACCES on a path we do not own).
        // Retrying will not help, and the temp dir is disposable either way.
        break;
      }
      if (attempt < attempts) sleep(delayMs * attempt);
    }
  }

  const code = errorCode(lastError) ?? 'unknown';
  log(
    `[test-cleanup] gave up removing temp dir after ${attempts} attempts (${code}): ${path} -- ` +
      'leaving it for the OS to reap'
  );
}
