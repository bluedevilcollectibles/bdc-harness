/**
 * WO-170: tests for silent-failure detector.
 *
 * Anchor scenario: 2026-05-16 sortie node emitted `STATUS=push_failed` on
 * stdout while exiting 0. UI showed green. 13 specs lost. Detector MUST
 * catch that pattern even without load_bearing opt-in.
 */
import { describe, it, expect } from 'bun:test';
import { detectSilentFailure, ALWAYS_DANGEROUS_FAILURE_PATTERNS } from './silent-failure-detector';

describe('detectSilentFailure', () => {
  it('returns null for empty stdout', () => {
    expect(detectSilentFailure('', false)).toBeNull();
    expect(detectSilentFailure('', true)).toBeNull();
  });

  it('returns null when stdout has no STATUS lines', () => {
    expect(detectSilentFailure('hello world\nall good\n', false)).toBeNull();
    expect(detectSilentFailure('hello world\nall good\n', true)).toBeNull();
  });

  it('returns null for STATUS=ok or other non-failed status', () => {
    expect(detectSilentFailure('STATUS=ok\n', true)).toBeNull();
    expect(detectSilentFailure('STATUS=completed\n', true)).toBeNull();
    expect(detectSilentFailure('STATUS=pending\n', true)).toBeNull();
  });

  it('detects push_failed even without load_bearing (always-dangerous)', () => {
    const result = detectSilentFailure('work done\nSTATUS=push_failed\nremote rejected\n', false);
    expect(result).not.toBeNull();
    expect(result?.patterns).toEqual(['push_failed']);
    expect(result?.loadBearing).toBe(false);
    expect(result?.statusLine).toContain('STATUS=push_failed');
  });

  it('detects all always-dangerous patterns without load_bearing', () => {
    for (const pattern of ALWAYS_DANGEROUS_FAILURE_PATTERNS) {
      const result = detectSilentFailure(`STATUS=${pattern}\n`, false);
      expect(result?.patterns).toEqual([pattern]);
    }
  });

  it('does NOT detect author-defined patterns without load_bearing', () => {
    const result = detectSilentFailure('STATUS=custom_step_failed\n', false);
    expect(result).toBeNull();
  });

  it('detects ANY *_failed pattern when load_bearing=true', () => {
    const result = detectSilentFailure('STATUS=custom_step_failed\n', true);
    expect(result?.patterns).toEqual(['custom_step_failed']);
    expect(result?.loadBearing).toBe(true);
  });

  it('captures multiple distinct patterns in one stdout', () => {
    const stdout = [
      'step 1 done',
      'STATUS=push_failed',
      'retry attempted',
      'STATUS=bundle_save_failed',
      'STATUS=push_failed', // duplicate; should dedupe in patterns array
    ].join('\n');
    const result = detectSilentFailure(stdout, false);
    expect(result?.patterns.sort()).toEqual(['bundle_save_failed', 'push_failed']);
    // statusLine includes all 3 matches (incl. duplicate line)
    expect(result?.statusLine.split('\n').length).toBe(3);
  });

  it('matches STATUS=*_failed embedded in a longer line', () => {
    const result = detectSilentFailure(
      '[2026-05-16T18:32:00Z] node-output STATUS=push_failed (exit handler completed)\n',
      false
    );
    expect(result?.patterns).toEqual(['push_failed']);
    expect(result?.statusLine).toContain('exit handler completed');
  });

  it('is case-sensitive on STATUS= prefix (matches existing node convention)', () => {
    expect(detectSilentFailure('status=push_failed\n', false)).toBeNull();
    expect(detectSilentFailure('Status=push_failed\n', false)).toBeNull();
  });

  it('anchor: 2026-05-16 sortie scenario — exit-0 + push_failed on stdout', () => {
    const realWorldStdout = [
      'Committed 13 files',
      'Pushing to origin...',
      'STATUS=push_failed',
      'Bundle saved to host-artifacts/',
      '',
    ].join('\n');
    const result = detectSilentFailure(realWorldStdout, false);
    expect(result).not.toBeNull();
    expect(result?.patterns).toContain('push_failed');
  });
});
