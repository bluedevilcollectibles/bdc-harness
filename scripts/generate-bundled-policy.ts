#!/usr/bin/env bun
/**
 * Regenerates packages/workflows/src/defaults/bundled-policy.generated.ts
 * from the canonical BDC Universal Agent Behavior Policy at
 *   bluedevilcollectibles/bdc-xo:harness/policies/agent-behavior.md
 *
 * Why this exists (WO-HARNESS-POLICYFILE-NOT-ENFORCED-01, Approach B):
 *   Cauldron workflow YAMLs declare `policyFile: harness/policies/agent-behavior.md`
 *   but the file lives ONLY in the `bdc-xo` repo. For every other registered
 *   codebase the local resolution failed and the policy was either missing or
 *   the run aborted late. The fix bundles the canonical text into the engine
 *   so the resolver can fall back to a deterministic copy.
 *
 * Determinism: the canonical text is fetched once and inlined as a string
 * literal (same approach as scripts/generate-bundled-defaults.ts). The
 * generated file also exports a SHA256 of the policy text so the resolver
 * and the `--check` mode can verify drift without re-fetching.
 *
 * Usage:
 *   bun run scripts/generate-bundled-policy.ts           # write
 *   bun run scripts/generate-bundled-policy.ts --check   # verify (exit 2 if stale)
 *
 * Exit codes:
 *   0  file generated (or unchanged, if --check)
 *   1  unexpected error (gh missing, fetch failure, etc.)
 *   2  --check was passed and the file would change
 *
 * Authority: canonical content is OWNED by bdc-xo. This script never mutates
 * the policy. It only mirrors it into the engine bundle.
 */
import { createHash } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const REPO_ROOT = resolve(import.meta.dir, '..');
const OUTPUT_PATH = join(REPO_ROOT, 'packages/workflows/src/defaults/bundled-policy.generated.ts');

const CANONICAL_OWNER = 'bluedevilcollectibles';
const CANONICAL_REPO = 'bdc-xo';
const CANONICAL_PATH = 'harness/policies/agent-behavior.md';

const CHECK_ONLY = process.argv.includes('--check');

interface CanonicalPolicy {
  content: string;
  sha256: string;
}

function fetchCanonicalPolicy(): CanonicalPolicy {
  const apiPath = `repos/${CANONICAL_OWNER}/${CANONICAL_REPO}/contents/${CANONICAL_PATH}`;
  const result = spawnSync('gh', ['api', apiPath, '--jq', '.content'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const stderr = result.stderr ?? '';
    throw new Error(
      `Failed to fetch canonical policy via 'gh api ${apiPath}'. ` +
        `Verify 'gh auth status' has read access to ${CANONICAL_OWNER}/${CANONICAL_REPO}.\n` +
        `stderr: ${stderr.trim()}`
    );
  }
  const base64 = (result.stdout ?? '').replace(/\s+/g, '');
  if (!base64) {
    throw new Error(
      `Canonical policy fetch returned empty content from ${CANONICAL_OWNER}/${CANONICAL_REPO}:${CANONICAL_PATH}`
    );
  }
  // GitHub returns blob content base64-encoded; normalize line endings to LF
  // so the bundle is identical regardless of where it was generated.
  const decoded = Buffer.from(base64, 'base64').toString('utf-8').replace(/\r\n/g, '\n');
  if (!decoded.trim()) {
    throw new Error(
      `Canonical policy is empty after decoding from ${CANONICAL_OWNER}/${CANONICAL_REPO}:${CANONICAL_PATH}`
    );
  }
  const sha256 = createHash('sha256').update(decoded, 'utf-8').digest('hex');
  return { content: decoded, sha256 };
}

function renderFile(policy: CanonicalPolicy): string {
  const header = [
    '/**',
    ' * AUTO-GENERATED — DO NOT EDIT.',
    ' *',
    ' * Bundled canonical BDC Universal Agent Behavior Policy.',
    ' *',
    ` * Source of truth: ${CANONICAL_OWNER}/${CANONICAL_REPO}:${CANONICAL_PATH}`,
    ' *',
    ' * Regenerate with: bun run scripts/generate-bundled-policy.ts',
    ' * Verify up-to-date:  bun run scripts/generate-bundled-policy.ts --check',
    ' *',
    ' * Why: Cauldron workflows declare `policyFile: harness/policies/agent-behavior.md`',
    ' * but only `bdc-xo` ships that file at that path. The resolver in',
    ' * `policy-resolver.ts` falls back to this bundled copy for every other repo.',
    ' *',
    ' * Approach B per WO-HARNESS-POLICYFILE-NOT-ENFORCED-01.',
    ' */',
    '',
  ].join('\n');

  return [
    header,
    '/** Canonical workflow-declared policy path. */',
    `export const BUNDLED_AGENT_BEHAVIOR_POLICY_PATH = ${JSON.stringify(CANONICAL_PATH)} as const;`,
    '',
    '/** SHA256 of the canonical policy text (LF-normalized, UTF-8). */',
    `export const BUNDLED_AGENT_BEHAVIOR_POLICY_SHA256 = ${JSON.stringify(policy.sha256)} as const;`,
    '',
    '/** Verbatim canonical policy text. Never hand-edited. */',
    `export const BUNDLED_AGENT_BEHAVIOR_POLICY = ${JSON.stringify(policy.content)};`,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const policy = fetchCanonicalPolicy();
  const contents = renderFile(policy);

  if (CHECK_ONLY) {
    let existing = '';
    try {
      const raw = await readFile(OUTPUT_PATH, 'utf-8');
      existing = raw.replace(/\r\n/g, '\n');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw err;
    }
    if (existing !== contents) {
      console.error(
        'bundled-policy.generated.ts is stale.\n' +
          'Run: bun run scripts/generate-bundled-policy.ts'
      );
      process.exit(2);
    }
    console.log(
      `bundled-policy.generated.ts is up to date (sha256=${policy.sha256.slice(0, 12)}...).`
    );
    return;
  }

  await writeFile(OUTPUT_PATH, contents, 'utf-8');
  console.log(`Wrote ${OUTPUT_PATH}\n  sha256=${policy.sha256}\n  ${policy.content.length} bytes`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
