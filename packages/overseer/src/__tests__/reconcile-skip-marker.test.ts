/**
 * Reconcile must treat `Reconcile-Skip: <WO-ID>` as "this PR is NOT evidence
 * for <WO-ID>", and must not close a tracker on a PR whose only link to the WO
 * is a prose mention.
 *
 * Anchor (2026-09-02, bdc-xo #1889 = WO-LSPRO-M157-STREAM-STAYS-OPEN-UI-01):
 * three merged PRs named the WO that morning --
 *   bdc-xo #1898       the WO's own spec amendment (Reconcile-Skip, spec-only)
 *   lspro-react #570   a different fix that mentioned the WO (Reconcile-Skip)
 *   shopops #662       the WO this one depends_on (NO skip line; the UI stem
 *                      appears once, in a reply to an Overseer finding)
 * -- and reconcile closed #1889 at 13:50:36Z on shopops #662, then re-closed it
 * at 13:51:33Z after XO reopened it by hand. None of the three implements the
 * WO; its stop-condition greps were 0 on staging.
 *
 * The three PR bodies below are the real ones, captured with
 * `gh pr view <n> --repo <owner/repo> --json body` into fixtures/reconcile/.
 */

import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RECONCILE_ACTION,
  RECONCILE_SKIP_ACTION,
  classifyPullRequestStems,
  extractDeclaredWoStems,
  extractReconcileSkipStems,
  isSpecOnlyChangeSet,
  runReconcileOnce,
  type ReconcileMergedPullRequest,
  type ReconcileTrackerIssue,
} from '../reconcile';
import { fakeDeps, mergedPr, stem } from './reconcile.test';

const UI_WO = 'WO-LSPRO-M157-STREAM-STAYS-OPEN-UI-01';
const SERVER_WO = 'WO-SHOPOPS-M157-STREAM-STAYS-OPEN-01';
const SPLIT_WO = 'WO-SHOPOPS-M157-STAGING-SPLIT-01';

interface FixtureMeta {
  owner: string;
  repo: string;
  number: number;
  title: string;
  mergedAt: string;
  mergeCommitSha: string;
  baseRefName: string;
  files: string[];
}

interface FixturePr {
  pr: ReconcileMergedPullRequest;
  files: string[];
}

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/reconcile/${name}`, import.meta.url));
}

function loadFixturePr(name: string): FixturePr {
  const meta = JSON.parse(readFileSync(fixturePath(`${name}.meta.json`), 'utf8')) as FixtureMeta;
  const body = readFileSync(fixturePath(`${name}.body.md`), 'utf8');
  return {
    pr: {
      owner: meta.owner,
      repo: meta.repo,
      number: meta.number,
      title: meta.title,
      body,
      htmlUrl: `https://github.com/${meta.owner}/${meta.repo}/pull/${meta.number}`,
      state: 'closed',
      merged: true,
      mergeCommitSha: meta.mergeCommitSha,
      mergedAt: meta.mergedAt,
    },
    files: meta.files,
  };
}

const specAmendment = loadFixturePr('bdc-xo-1898');
const comicCardFix = loadFixturePr('lspro-react-570');
const serverHalf = loadFixturePr('shopops-662');

function prRef(pr: ReconcileMergedPullRequest): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

/** Tracker lookup that knows the two real M-157 trackers and nothing else. */
function m157Trackers(
  open: string[]
): (candidate: string) => Promise<ReconcileTrackerIssue | null> {
  const numbers: Record<string, number> = { [UI_WO]: 1889, [SERVER_WO]: 1887 };
  return async candidate => {
    const number = numbers[candidate];
    if (!number) return null;
    return {
      owner: 'thinmansoftware',
      repo: 'bdc-xo',
      number,
      title: candidate,
      state: open.includes(candidate) ? 'open' : 'closed',
    };
  };
}

function filesFromFixtures(
  ...fixtures: FixturePr[]
): (pr: ReconcileMergedPullRequest) => Promise<string[]> {
  const byRef = new Map(fixtures.map(f => [prRef(f.pr), f.files]));
  return async pr => {
    const files = byRef.get(prRef(pr));
    if (!files) throw new Error(`no fixture file list for ${prRef(pr)}`);
    return files;
  };
}

describe('extractReconcileSkipStems -- marker syntax', () => {
  test('canonical single id', () => {
    expect([...extractReconcileSkipStems(`Body.\n\nReconcile-Skip: ${stem}\n`)]).toEqual([stem]);
  });

  test('keyword in any case', () => {
    expect([...extractReconcileSkipStems(`reconcile-skip: ${stem}`)]).toEqual([stem]);
    expect([...extractReconcileSkipStems(`RECONCILE-SKIP: ${stem}`)]).toEqual([stem]);
    expect([...extractReconcileSkipStems(`Reconcile-skip:${stem}`)]).toEqual([stem]);
  });

  test('ids in lower case are normalised to the tracker title case', () => {
    expect([...extractReconcileSkipStems(`Reconcile-Skip: ${stem.toLowerCase()}`)]).toEqual([stem]);
  });

  test('one or more ids, comma and/or space separated', () => {
    const line = `Reconcile-Skip: WO-A-B-01, WO-C-D-02 WO-E-F-03,WO-G-H-04`;
    expect([...extractReconcileSkipStems(line)]).toEqual([
      'WO-A-B-01',
      'WO-C-D-02',
      'WO-E-F-03',
      'WO-G-H-04',
    ]);
  });

  test('several marker lines accumulate', () => {
    const body = `Reconcile-Skip: WO-A-B-01\nSome prose.\nreconcile-skip: WO-C-D-02\n`;
    expect([...extractReconcileSkipStems(body)]).toEqual(['WO-A-B-01', 'WO-C-D-02']);
  });

  test('CRLF line endings (GitHub web-UI edited bodies)', () => {
    const body = `Implements WO-A-B-01.\r\n\r\nReconcile-Skip: WO-C-D-02, WO-E-F-03\r\n\r\nTrailer.\r\n`;
    expect([...extractReconcileSkipStems(body)]).toEqual(['WO-C-D-02', 'WO-E-F-03']);
  });

  test('a sentence that merely talks about the marker mid-line does not fire it', () => {
    const body = `Authors add Reconcile-Skip: WO-A-B-01 to a PR when it is not the build.`;
    expect(extractReconcileSkipStems(body).size).toBe(0);
  });

  test('the three real bodies: #1898 and #570 skip the UI WO, #662 carries no marker', () => {
    expect([...extractReconcileSkipStems(specAmendment.pr.body ?? '')]).toEqual([UI_WO]);
    expect([...extractReconcileSkipStems(comicCardFix.pr.body ?? '')]).toEqual([UI_WO]);
    expect(extractReconcileSkipStems(serverHalf.pr.body ?? '').size).toBe(0);
  });
});

describe('extractDeclaredWoStems -- manifest WO: lines', () => {
  test('#662 declares the server WO only', () => {
    expect(extractDeclaredWoStems(serverHalf.pr.body ?? '')).toEqual([SERVER_WO]);
  });

  test('#570 declares the UI WO (and skips it)', () => {
    expect(extractDeclaredWoStems(comicCardFix.pr.body ?? '')).toEqual([UI_WO]);
  });

  test('#1898 has no manifest', () => {
    expect(extractDeclaredWoStems(specAmendment.pr.body ?? '')).toEqual([]);
  });

  test('a template placeholder `WO: [WO ID]` declares nothing', () => {
    expect(extractDeclaredWoStems('WO: [WO ID]\nBuilder: [name]')).toEqual([]);
  });
});

describe('classifyPullRequestStems -- what a merged PR is evidence for', () => {
  test('#1898 (spec amendment): the UI WO is skipped, nothing is evidence', () => {
    expect(classifyPullRequestStems(specAmendment.pr)).toEqual({
      evidence: [],
      skipped: [UI_WO],
      incidental: [],
    });
  });

  test('#570 (different fix that names the WO): the UI WO is skipped, nothing is evidence', () => {
    expect(classifyPullRequestStems(comicCardFix.pr)).toEqual({
      evidence: [],
      skipped: [UI_WO],
      incidental: [],
    });
  });

  test('#662 (the dependency): evidence for the server WO it declares; the UI WO and the staging-split WO are incidental mentions', () => {
    const classified = classifyPullRequestStems(serverHalf.pr);
    expect(classified.evidence).toEqual([SERVER_WO]);
    expect(classified.skipped).toEqual([]);
    expect(classified.incidental.sort()).toEqual([SPLIT_WO, UI_WO].sort());
  });

  test('a skipped id does not stop the PR counting for the other ids it names', () => {
    const classified = classifyPullRequestStems({
      title: 'feat: WO-A-B-01 and WO-C-D-02 together',
      body: `Implements both.\n\nReconcile-Skip: WO-A-B-01\n`,
    });
    expect(classified.evidence).toEqual(['WO-C-D-02']);
    expect(classified.skipped).toEqual(['WO-A-B-01']);
  });

  test('a stem in the title counts alongside the manifest declaration', () => {
    const classified = classifyPullRequestStems({
      title: 'WO-A-B-01: build',
      body: 'Follow-up is WO-E-F-03.\n\n```\nWO: WO-C-D-02\nBuilder: x\n```\n',
    });
    expect(classified.evidence.sort()).toEqual(['WO-A-B-01', 'WO-C-D-02']);
    expect(classified.incidental).toEqual(['WO-E-F-03']);
  });

  test('legacy PR with no manifest: every mentioned stem is a candidate (unchanged)', () => {
    expect(classifyPullRequestStems(mergedPr())).toEqual({
      evidence: [stem],
      skipped: [],
      incidental: [],
    });
  });
});

describe('runReconcileOnce -- replay of the 2026-09-02 morning', () => {
  test('the three real merged PRs together do NOT close #1889', async () => {
    const deps = fakeDeps({ prs: [specAmendment.pr, comicCardFix.pr, serverHalf.pr] });
    const findTracker = mock(m157Trackers([UI_WO]));
    const listFiles = mock(filesFromFixtures(specAmendment, comicCardFix, serverHalf));

    const result = await runReconcileOnce({
      deps: { ...deps, findTrackerIssueByStem: findTracker, listPullRequestFiles: listFiles },
    });

    expect(result).toEqual({ scanned: 3, closed: 0, skipped: false });
    expect(deps.closes).toEqual([]);
    expect(deps.labels).toEqual([]);
    expect(deps.comments).toEqual([]);
    // The UI tracker is never even looked up: every reference to it was either
    // skip-marked or incidental.
    const lookedUp = findTracker.mock.calls.map(call => call[0]);
    expect(lookedUp).not.toContain(UI_WO);
    expect(lookedUp).toContain(SERVER_WO);
    // Audit trail: one skip row per skip-marked PR, no close rows.
    expect(deps.actions).toMatchObject([
      { prRef: 'thinmansoftware/bdc-xo#1898', woId: UI_WO, action: RECONCILE_SKIP_ACTION },
      { prRef: 'thinmansoftware/lspro-react#570', woId: UI_WO, action: RECONCILE_SKIP_ACTION },
    ]);
    expect(deps.actions.filter(a => a.action === RECONCILE_ACTION)).toEqual([]);
    expect(deps.infos).toContain('overseer.reconcile.incidental_mention_not_evidence');
  });

  test('#662 alone: the prose mention of the UI WO is not evidence for #1889', async () => {
    const deps = fakeDeps({ prs: [serverHalf.pr] });
    const findTracker = mock(m157Trackers([UI_WO]));

    const result = await runReconcileOnce({
      deps: {
        ...deps,
        findTrackerIssueByStem: findTracker,
        listPullRequestFiles: filesFromFixtures(serverHalf),
      },
    });

    expect(result.closed).toBe(0);
    expect(deps.closes).toEqual([]);
    expect(findTracker.mock.calls.map(call => call[0])).not.toContain(UI_WO);
  });

  test('#662 still closes the tracker for the WO it DOES implement (#1887)', async () => {
    const deps = fakeDeps({ prs: [serverHalf.pr] });

    const result = await runReconcileOnce({
      deps: {
        ...deps,
        findTrackerIssueByStem: m157Trackers([SERVER_WO, UI_WO]),
        listPullRequestFiles: filesFromFixtures(serverHalf),
      },
    });

    expect(result.closed).toBe(1);
    expect(deps.closes).toEqual([1887]);
    expect(deps.comments).toHaveLength(1);
    expect(deps.comments[0]).toContain(`Overseer reconcile closed tracker for ${SERVER_WO}.`);
    expect(deps.actions).toMatchObject([
      { prRef: 'thinmansoftware/shopops#662', woId: SERVER_WO, action: RECONCILE_ACTION },
    ]);
  });

  test('#570 with its skip line: the file listing is never fetched and no comment is posted', async () => {
    const deps = fakeDeps({ prs: [comicCardFix.pr] });
    const listFiles = mock(filesFromFixtures(comicCardFix));

    await runReconcileOnce({
      deps: {
        ...deps,
        findTrackerIssueByStem: m157Trackers([UI_WO]),
        listPullRequestFiles: listFiles,
      },
    });

    expect(listFiles).not.toHaveBeenCalled();
    expect(deps.comments).toEqual([]);
    expect(deps.closes).toEqual([]);
  });
});

describe('spec-only guard with the real #1898 fixture', () => {
  test('#1898 touches only docs/work-orders/<WO-ID>.md in the tracker repo', () => {
    expect(specAmendment.pr.repo).toBe('bdc-xo');
    expect(specAmendment.files).toEqual([`docs/work-orders/${UI_WO}.md`]);
    expect(isSpecOnlyChangeSet(specAmendment.files)).toBe(true);
  });

  test('even WITHOUT its skip line, #1898 cannot close #1889 (spec-only merge)', async () => {
    const bodyWithoutSkip = (specAmendment.pr.body ?? '').replace(/^Reconcile-Skip:.*$/gim, '');
    expect(extractReconcileSkipStems(bodyWithoutSkip).size).toBe(0);
    const deps = fakeDeps({ prs: [{ ...specAmendment.pr, body: bodyWithoutSkip }] });

    const result = await runReconcileOnce({
      deps: {
        ...deps,
        findTrackerIssueByStem: m157Trackers([UI_WO]),
        listPullRequestFiles: filesFromFixtures(specAmendment),
      },
    });

    expect(result.closed).toBe(0);
    expect(deps.closes).toEqual([]);
    expect(deps.labels).toEqual([]);
    expect(deps.warnings).toContain('overseer.reconcile.spec_only_merge_tracker_left_open');
  });
});

describe('re-close guard -- a human reopen is not undone by the same PR', () => {
  test('a PR that already closed this tracker once leaves it open on the next pass', async () => {
    const deps = fakeDeps({ closeAlreadyRecorded: true });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    expect(deps.closes).toEqual([]);
    expect(deps.labels).toEqual([]);
    expect(deps.comments).toEqual([]);
    expect(deps.actions).toEqual([]);
    expect(deps.warnings).toContain('overseer.reconcile.tracker_reopened_after_close_left_open');
  });

  test('the 13:51Z replay: #662 re-scanned after XO reopened #1889 -- with the old evidence rule it must still not re-close', async () => {
    // Belt and braces: even if the UI stem were evidence (it is not), a
    // recorded close for prRef+woId blocks the second close.
    const deps = fakeDeps({ prs: [serverHalf.pr], closeAlreadyRecorded: true });

    const result = await runReconcileOnce({
      deps: {
        ...deps,
        findTrackerIssueByStem: m157Trackers([SERVER_WO]),
        listPullRequestFiles: filesFromFixtures(serverHalf),
      },
    });

    expect(result.closed).toBe(0);
    expect(deps.closes).toEqual([]);
    expect(deps.warnings).toContain('overseer.reconcile.tracker_reopened_after_close_left_open');
  });

  test('a PR that has never closed this tracker closes it (guard is inert on first sight)', async () => {
    const deps = fakeDeps({ closeAlreadyRecorded: false });

    const result = await runReconcileOnce({ deps });

    expect(result.closed).toBe(1);
    expect(deps.closes).toEqual([1044]);
  });
});
