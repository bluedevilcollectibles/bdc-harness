/**
 * already-satisfied.ts -- WO claim / already-landed detection.
 *
 * Anchor: bdc-xo#1546 (four lanes concurrently built the same WO; redundant PRs).
 * Anchor: M-123 Q5 (refuse fire when open/merged PR for WO already exists).
 * Anchor: fire.ps1 already-satisfied gate (human path only -- conductor was blind).
 *
 * Exact WO_ID match only (avoids #1490 false positives on shared prefixes like
 * WO-HARNESS-*-01). Injectable lookup for tests.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type WoClaimState = 'OPEN' | 'MERGED';

export interface WoClaim {
  readonly number: number;
  readonly state: WoClaimState;
  readonly title: string;
  readonly url: string;
  readonly repo: string;
}

export interface FindWoClaimOptions {
  readonly woId: string;
  readonly project: string;
  /** Override gh lookup (tests). */
  readonly lookup?: (repo: string, woId: string) => Promise<WoClaim[]>;
}

/**
 * Map a Smart Cauldron --project shortname to a GitHub owner/repo.
 * Accepts bare shortnames (shopops) or already-qualified names.
 */
export function resolveGithubRepo(project: string): string {
  const trimmed = project.trim();
  if (!trimmed) {
    throw new Error('[smart-cauldron/already-satisfied] project is required');
  }
  if (trimmed.includes('/')) {
    const parts = trimmed.split('/').filter(Boolean);
    const owner = parts[parts.length - 2] ?? 'thinmansoftware';
    const repo = parts[parts.length - 1] ?? trimmed;
    return `${owner}/${repo}`;
  }
  return `thinmansoftware/${trimmed}`;
}

/**
 * Markdown headings that mark following lines as explicitly OUT of scope for
 * the PR that contains them -- a WO id mentioned there is a disclaimer
 * ("I deliberately did not touch this"), not a claim of having done it.
 *
 * Anchor: bdc-xo#1795 -- shopops-comic-theme PR #62
 * (WO-COMICTHEME-CARD-GUARANTEE-SCOPE-FIX-01) listed
 * "comic-card.liquid body/actions block (owned by WO-COMICTHEME-CARD-MODERN-PARITY-01)"
 * under "## Files explicitly out of scope". textClaimsWoId read that mention
 * as a claim and permanently blocked WO-COMICTHEME-CARD-MODERN-PARITY-01 from
 * firing. Mechanism was correct (real match); the inference was wrong
 * (ownership disclaimer, not completion claim).
 */
const EXCLUSION_HEADING_RE =
  /^\s{0,3}#{1,6}\s*(files?\s+)?(explicitly\s+)?(out\s+of\s+scope|not\s+in\s+scope|explicitly\s+excluded)\b/i;
/** Any markdown heading (# through ######) closes an exclusion section. */
const ANY_HEADING_RE = /^\s{0,3}#{1,6}\s+\S/;

/**
 * Strip lines that fall under an "out of scope" / "not in scope" /
 * "explicitly excluded" heading, up to the next heading of any level (or
 * end of text). Applied before the WO-id scan so exclusion-listed mentions
 * never reach the matcher.
 */
function stripExclusionSections(text: string): string {
  if (!text) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let inExclusion = false;
  for (const line of lines) {
    if (EXCLUSION_HEADING_RE.test(line)) {
      inExclusion = true;
      continue;
    }
    if (inExclusion && ANY_HEADING_RE.test(line)) {
      inExclusion = false;
    }
    if (!inExclusion) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * True when text contains the exact WO_ID as a token (not a longer sibling id),
 * OUTSIDE any "explicitly out of scope" section. "WO-FOO-01" must not match
 * "WO-FOO-010". Branch suffixes like "-thread-abc" after the id are allowed
 * (hyphen is a boundary). Case-insensitive.
 */
export function textClaimsWoId(text: string, woId: string): boolean {
  if (!woId || !text) return false;
  const hay = stripExclusionSections(text).toLowerCase();
  const needle = woId.toLowerCase();
  let from = 0;
  while (from <= hay.length) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) return false;
    const before = idx === 0 ? '' : hay[idx - 1];
    const afterIdx = idx + needle.length;
    const after = afterIdx >= hay.length ? '' : hay[afterIdx];
    const beforeOk = idx === 0 || /[^a-z0-9]/.test(before);
    const afterOk = after === '' || /[^a-z0-9]/.test(after);
    if (beforeOk && afterOk) return true;
    from = idx + 1;
  }
  return false;
}

interface GhPrRow {
  number?: number;
  state?: string;
  title?: string;
  url?: string;
  headRefName?: string;
  body?: string;
}

async function ghPrSearchDefault(repo: string, woId: string): Promise<WoClaim[]> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'all',
        '--search',
        woId,
        '--limit',
        '20',
        '--json',
        'number,state,title,url,headRefName,body',
      ],
      { timeout: 30000 }
    );
    const rows = JSON.parse(stdout || '[]') as GhPrRow[];
    if (!Array.isArray(rows)) return [];
    const out: WoClaim[] = [];
    for (const row of rows) {
      const stateRaw = (row.state ?? '').toUpperCase();
      if (stateRaw !== 'OPEN' && stateRaw !== 'MERGED') continue;
      const number = typeof row.number === 'number' ? row.number : NaN;
      if (!Number.isFinite(number)) continue;
      const title = row.title ?? '';
      const body = row.body ?? '';
      const head = row.headRefName ?? '';
      const url = row.url ?? '';
      if (
        !textClaimsWoId(title, woId) &&
        !textClaimsWoId(body, woId) &&
        !textClaimsWoId(head, woId)
      ) {
        continue;
      }
      out.push({
        number,
        state: stateRaw as WoClaimState,
        title,
        url,
        repo,
      });
    }
    return out;
  } catch {
    // Fail open on gh outage -- cascade must not die because GitHub search blipped.
    // Callers treat null/empty as "unknown, proceed" and rely on other gates.
    return [];
  }
}

/**
 * Find an open or merged PR that already claims this WO in the target repo.
 * Returns the strongest claim (MERGED preferred over OPEN), or null.
 */
export async function findWoClaim(opts: FindWoClaimOptions): Promise<WoClaim | null> {
  const repo = resolveGithubRepo(opts.project);
  const lookup = opts.lookup ?? ghPrSearchDefault;
  const claims = await lookup(repo, opts.woId);
  if (claims.length === 0) return null;
  const merged = claims.find(c => c.state === 'MERGED');
  if (merged) return merged;
  return claims[0] ?? null;
}
