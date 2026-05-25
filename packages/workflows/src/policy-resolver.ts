/**
 * Workflow policyFile resolver.
 *
 * Resolves the path declared by `workflow.policyFile` to actual policy text.
 * Backs the executor's `applyWorkflowPolicyFile`. Approach B per
 * WO-HARNESS-POLICYFILE-NOT-ENFORCED-01.
 *
 * Resolution order:
 *   1. `resolve(cwd, policyFile)` — local file in the target worktree.
 *      If present, its SHA256 is computed. A SHA256 match against the
 *      bundled canonical means "RESOLVED via local"; a mismatch logs a
 *      warning and falls through to bundled so stale local copies cannot
 *      silently override the canonical policy.
 *   2. Bundled canonical — used when `policyFile` equals
 *      BUNDLED_AGENT_BEHAVIOR_POLICY_PATH and step 1 didn't return a
 *      verified local copy.
 *   3. Throw `policyFile not found: ...` — neither source resolves.
 *
 * Empty resolved content also throws.
 */
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { createLogger } from '@archon/paths';
import {
  BUNDLED_AGENT_BEHAVIOR_POLICY,
  BUNDLED_AGENT_BEHAVIOR_POLICY_PATH,
  BUNDLED_AGENT_BEHAVIOR_POLICY_SHA256,
} from './defaults/bundled-policy.generated';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.policy-resolver');
  return cachedLog;
}

export type PolicySource = 'local' | 'bundled';

export interface ResolvedPolicy {
  /** Verbatim policy text to inject into prompt nodes. */
  readonly content: string;
  /** Where the content came from. */
  readonly source: PolicySource;
  /** Path resolved on disk (when source === 'local'); undefined for bundled. */
  readonly resolvedPath?: string;
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Read the local file at `resolve(cwd, policyFile)` and LF-normalize it.
 * Returns undefined when the file is absent or unreadable.
 */
async function readLocalPolicy(
  cwd: string,
  policyFile: string
): Promise<{ content: string; resolvedPath: string } | undefined> {
  const resolvedPath = resolve(cwd, policyFile);
  try {
    const raw = await readFile(resolvedPath, 'utf-8');
    return { content: raw.replace(/\r\n/g, '\n'), resolvedPath };
  } catch {
    return undefined;
  }
}

/**
 * Resolve a workflow's policyFile declaration to actual policy text.
 *
 * @throws Error - when neither a local nor a bundled canonical source resolves,
 *         or when the resolved content is empty.
 */
export async function resolveWorkflowPolicyFile(
  policyFile: string,
  cwd: string
): Promise<ResolvedPolicy> {
  const local = await readLocalPolicy(cwd, policyFile);

  if (local) {
    if (!local.content.trim()) {
      throw new Error(`policyFile is empty: ${policyFile}`);
    }
    const localSha = sha256Hex(local.content);
    if (localSha === BUNDLED_AGENT_BEHAVIOR_POLICY_SHA256) {
      return { content: local.content, source: 'local', resolvedPath: local.resolvedPath };
    }
    // Local file exists but does not match the bundled canonical. Do not
    // silently override the canonical policy with a drifted local copy —
    // fall through to bundled if the declared path is the canonical path,
    // otherwise honor the local file (custom policy paths are intentional).
    if (policyFile === BUNDLED_AGENT_BEHAVIOR_POLICY_PATH) {
      getLog().warn(
        {
          policyFile,
          resolvedPath: local.resolvedPath,
          localSha256: localSha,
          bundledSha256: BUNDLED_AGENT_BEHAVIOR_POLICY_SHA256,
        },
        'policy.local_sha256_mismatch'
      );
      return { content: BUNDLED_AGENT_BEHAVIOR_POLICY, source: 'bundled' };
    }
    // Non-canonical policyFile path: caller authored their own policy.
    // Honor it as-is.
    return { content: local.content, source: 'local', resolvedPath: local.resolvedPath };
  }

  // No local file. Fall back to bundled canonical ONLY when the declared
  // path matches the canonical policy path.
  if (policyFile === BUNDLED_AGENT_BEHAVIOR_POLICY_PATH) {
    if (!BUNDLED_AGENT_BEHAVIOR_POLICY.trim()) {
      // Defensive: bundled file should never be empty. If it is, the bundle
      // is broken and we must fail loud rather than ship a silent no-op.
      throw new Error(
        `policyFile not found: ${policyFile} — local missing and bundled canonical is empty (bundle build is broken)`
      );
    }
    return { content: BUNDLED_AGENT_BEHAVIOR_POLICY, source: 'bundled' };
  }

  throw new Error(
    `policyFile not found: ${policyFile} (resolved to ${resolve(cwd, policyFile)}) ` +
      'and no bundled canonical exists for that path. ' +
      `Bundled canonical is only available for '${BUNDLED_AGENT_BEHAVIOR_POLICY_PATH}'.`
  );
}
