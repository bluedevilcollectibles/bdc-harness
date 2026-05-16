/**
 * WO-170: Silent-failure detector.
 *
 * Scans bash/script stdout for `STATUS=*_failed` lines emitted by load-bearing
 * nodes that exited 0 — the classic silent-data-loss pattern anchored on the
 * 2026-05-16 engine sortie that completed all-green while losing 13 spec
 * files.
 *
 * Two trigger paths:
 *   1. `load_bearing: true` on the node (WO-167 doctrine, depended on by this
 *      WO) — ANY `STATUS=*_failed` line is a warning.
 *   2. Always-dangerous patterns — even on nodes that didn't opt in. These
 *      are signals of silent data loss regardless of authoring discipline.
 *
 * Does NOT change the underlying `STATUS=*_failed` convention itself; that's
 * owned by WO-169 and the node authors.
 */

/**
 * Patterns that always indicate silent data loss when seen on stdout, even
 * for nodes without `load_bearing: true`. Conservative list — only the
 * unambiguous ones go here. Author-defined warnings need the load_bearing
 * opt-in.
 */
const ALWAYS_DANGEROUS_PATTERNS = [
  'push_failed',
  'commit_failed',
  'pr_create_failed',
  'registry_write_failed',
  'artifact_persist_failed',
  'bundle_save_failed',
  'spec_save_failed',
] as const;

/** Result of a stdout scan. */
export interface SilentFailureDetection {
  /** The matched STATUS=... line(s), joined by \n for display. */
  statusLine: string;
  /** Which `*_failed` tokens were matched (e.g. ['push_failed']). */
  patterns: string[];
  /** True if triggered by load_bearing opt-in, false if by always-dangerous pattern. */
  loadBearing: boolean;
}

/**
 * Scan stdout for STATUS=*_failed lines. Returns null when nothing matches.
 *
 * Trigger logic:
 *   - load_bearing=true → ANY `STATUS=<name>_failed` is reported.
 *   - load_bearing=false → only ALWAYS_DANGEROUS_PATTERNS are reported.
 *
 * Match is line-based and case-sensitive on the STATUS prefix (matches what
 * existing nodes emit). The value side allows letters, digits, underscores.
 */
export function detectSilentFailure(
  stdout: string,
  loadBearing: boolean
): SilentFailureDetection | null {
  if (!stdout) return null;

  const matches: { line: string; pattern: string }[] = [];
  // Multi-line: scan each line for a STATUS=word_failed token.
  const statusRe = /^.*STATUS=([A-Za-z0-9_]+_failed)\b.*$/gm;
  let m: RegExpExecArray | null;
  while ((m = statusRe.exec(stdout)) !== null) {
    const pattern = m[1];
    const line = m[0];
    if (loadBearing) {
      matches.push({ line, pattern });
    } else if ((ALWAYS_DANGEROUS_PATTERNS as readonly string[]).includes(pattern)) {
      matches.push({ line, pattern });
    }
  }

  if (matches.length === 0) return null;

  // Deduplicate patterns; keep statusLine ordered as encountered.
  const seenPatterns = new Set<string>();
  const patterns: string[] = [];
  for (const { pattern } of matches) {
    if (!seenPatterns.has(pattern)) {
      seenPatterns.add(pattern);
      patterns.push(pattern);
    }
  }

  return {
    statusLine: matches.map(m => m.line).join('\n'),
    patterns,
    loadBearing,
  };
}

/**
 * Re-export the always-dangerous pattern list for tests/docs. Adding to this
 * list is a doctrine decision — keep it conservative.
 */
export const ALWAYS_DANGEROUS_FAILURE_PATTERNS: readonly string[] = ALWAYS_DANGEROUS_PATTERNS;
