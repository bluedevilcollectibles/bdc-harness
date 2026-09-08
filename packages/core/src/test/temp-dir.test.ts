import { describe, expect, test } from 'bun:test';
import { removeTempDirWithRetry } from './temp-dir';

function ebusy(): NodeJS.ErrnoException {
  const error = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException;
  error.code = 'EBUSY';
  return error;
}

describe('removeTempDirWithRetry', () => {
  test('returns after the removal succeeds on the third attempt', () => {
    let calls = 0;
    const sleeps: number[] = [];
    const logs: string[] = [];

    removeTempDirWithRetry('C:/tmp/archon-fixture', {
      rm: () => {
        calls += 1;
        if (calls <= 2) throw ebusy();
      },
      sleep: ms => sleeps.push(ms),
      log: message => logs.push(message),
    });

    expect(calls).toBe(3);
    expect(sleeps).toEqual([250, 500]);
    expect(logs).toEqual([]);
  });

  test('returns without throwing and logs once when every attempt fails', () => {
    let calls = 0;
    const logs: string[] = [];

    expect(() => {
      removeTempDirWithRetry('C:/tmp/archon-stuck', {
        attempts: 4,
        delayMs: 10,
        rm: () => {
          calls += 1;
          throw ebusy();
        },
        sleep: () => {},
        log: message => logs.push(message),
      });
    }).not.toThrow();

    expect(calls).toBe(4);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('EBUSY');
    expect(logs[0]).toContain('C:/tmp/archon-stuck');
  });

  test('removes on the first attempt without sleeping or logging', () => {
    let calls = 0;
    let slept = false;
    const logs: string[] = [];

    removeTempDirWithRetry('C:/tmp/archon-clean', {
      rm: () => {
        calls += 1;
      },
      sleep: () => {
        slept = true;
      },
      log: message => logs.push(message),
    });

    expect(calls).toBe(1);
    expect(slept).toBe(false);
    expect(logs).toEqual([]);
  });

  test('stops immediately on a non-retryable errno', () => {
    let calls = 0;
    const logs: string[] = [];

    removeTempDirWithRetry('C:/tmp/archon-denied', {
      rm: () => {
        calls += 1;
        const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      },
      sleep: () => {},
      log: message => logs.push(message),
    });

    expect(calls).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('EACCES');
  });

  test('retries ENOTEMPTY and EPERM as lock contention', () => {
    for (const code of ['ENOTEMPTY', 'EPERM']) {
      let calls = 0;
      removeTempDirWithRetry('C:/tmp/archon-' + code, {
        attempts: 3,
        delayMs: 1,
        rm: () => {
          calls += 1;
          if (calls < 2) {
            const error = new Error(code) as NodeJS.ErrnoException;
            error.code = code;
            throw error;
          }
        },
        sleep: () => {},
        log: () => {},
      });
      expect(calls).toBe(2);
    }
  });
});
