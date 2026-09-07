import { describe, expect, test } from 'bun:test';
import { RECONCILE_ACTION, RECONCILE_SKIP_ACTION, runReconcileOnce } from '../reconcile';
import { fakeDeps, mergedPr, stem } from './reconcile.test';

describe('reconcile partial completion skip marker', () => {
  test('Reconcile-Skip marker excludes the PR as evidence: no close, no comment, one skip action', async () => {
    // Behavior change 2026-09-02: the marker used to post a "noted merged PR
    // evidence" comment on the tracker. It now posts nothing -- the author
    // asked for the tracker to be left alone -- and records one audit row.
    const deps = fakeDeps({
      prs: [
        mergedPr({
          body: `Implements ${stem}.

Reconcile-Skip: ${stem}`,
        }),
      ],
    });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    expect(deps.comments).toEqual([]);
    expect(deps.findTrackerIssueByStem).not.toHaveBeenCalled();
    expect(deps.infos).toContain('overseer.reconcile.skip_marker_excluded_pr_evidence');
    expect(deps.labels).toEqual([]);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toMatchObject([
      {
        woId: stem,
        action: RECONCILE_SKIP_ACTION,
        result: 'https://github.com/thinmansoftware/bdc-harness/pull/404:abc123merge',
      },
    ]);
  });

  test('merged PR without Reconcile-Skip keeps existing close behavior unchanged', async () => {
    const deps = fakeDeps({ prs: [mergedPr({ body: `Implements ${stem}.` })] });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 1, skipped: false });
    expect(deps.comments).toHaveLength(1);
    expect(deps.comments[0]).toContain(`Overseer reconcile closed tracker for ${stem}.`);
    expect(deps.labels).toEqual(['wo:done']);
    expect(deps.closes).toEqual([1044]);
    expect(deps.actions).toMatchObject([
      {
        woId: stem,
        action: RECONCILE_ACTION,
        result: 'https://github.com/thinmansoftware/bdc-harness/pull/404:abc123merge',
      },
    ]);
  });

  test('already noted Reconcile-Skip marker does not double-post or double-record action', async () => {
    const deps = fakeDeps({
      skipAlreadyNoted: true,
      prs: [
        mergedPr({
          body: `Implements ${stem}.

Reconcile-Skip: ${stem}`,
        }),
      ],
    });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    expect(deps.comments).toEqual([]);
    expect(deps.labels).toEqual([]);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toEqual([]);
  });
});
