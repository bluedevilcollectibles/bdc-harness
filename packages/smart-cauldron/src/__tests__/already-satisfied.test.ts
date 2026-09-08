/**
 * already-satisfied.test.ts -- exact WO claim matching + findWoClaim.
 */

import { describe, expect, test } from 'bun:test';
import {
  findWoClaim,
  resolveGithubRepo,
  textClaimsWoId,
  type WoClaim,
} from '../already-satisfied.js';

describe('textClaimsWoId', () => {
  test('matches exact WO token in title', () => {
    expect(
      textClaimsWoId(
        'feat: WO-SHOPOPS-GARY-SUPPORT-VISIBILITY-01',
        'WO-SHOPOPS-GARY-SUPPORT-VISIBILITY-01'
      )
    ).toBe(true);
  });

  test('rejects sibling ids that share a prefix (#1490 class)', () => {
    // Longer id that continues with a digit/letter must not match the shorter WO.
    expect(textClaimsWoId('WO-HARNESS-FOO-010 done', 'WO-HARNESS-FOO-01')).toBe(false);
    expect(textClaimsWoId('WO-HARNESS-FOO-01A', 'WO-HARNESS-FOO-01')).toBe(false);
  });

  test('matches branch names containing the WO (case-insensitive)', () => {
    expect(
      textClaimsWoId(
        'feat/wo-shopops-gary-support-visibility-01-thread-abc',
        'WO-SHOPOPS-GARY-SUPPORT-VISIBILITY-01'
      )
    ).toBe(true);
    expect(
      textClaimsWoId(
        'feat/WO-SHOPOPS-GARY-SUPPORT-VISIBILITY-01-thread-abc',
        'WO-SHOPOPS-GARY-SUPPORT-VISIBILITY-01'
      )
    ).toBe(true);
  });

  test('ignores a WO id listed under an "explicitly out of scope" heading (#1795)', () => {
    // Real text from shopops-comic-theme PR #62's body.
    const body = [
      '## Files explicitly out of scope',
      '- `sections/product.liquid` (PDP -- committed-intent, spec says out of scope)',
      '- `comic-card.liquid` body/actions block (owned by WO-COMICTHEME-CARD-MODERN-PARITY-01)',
      '- Locale/translation files -- none needed',
      '',
      '## Verification commands',
      'grep -c foo bar.liquid',
    ].join('\n');
    expect(textClaimsWoId(body, 'WO-COMICTHEME-CARD-MODERN-PARITY-01')).toBe(false);
  });

  test('still matches the same WO id when it appears OUTSIDE an exclusion section', () => {
    const body = [
      '## Summary',
      'Implements WO-COMICTHEME-CARD-MODERN-PARITY-01.',
      '',
      '## Files explicitly out of scope',
      '- none',
    ].join('\n');
    expect(textClaimsWoId(body, 'WO-COMICTHEME-CARD-MODERN-PARITY-01')).toBe(true);
  });

  test('exclusion applies only until the next heading, not to the rest of the doc', () => {
    const body = [
      '## Files explicitly out of scope',
      '- unrelated line',
      '',
      '## Files modified',
      '- WO-COMICTHEME-CARD-MODERN-PARITY-01 actually implemented here',
    ].join('\n');
    expect(textClaimsWoId(body, 'WO-COMICTHEME-CARD-MODERN-PARITY-01')).toBe(true);
  });

  test('recognizes "not in scope" and "explicitly excluded" heading variants', () => {
    expect(textClaimsWoId('## Not in scope\n- WO-FOO-BAR-01 (deferred)', 'WO-FOO-BAR-01')).toBe(
      false
    );
    expect(textClaimsWoId('### Explicitly Excluded\n- WO-FOO-BAR-01', 'WO-FOO-BAR-01')).toBe(false);
  });
});

describe('resolveGithubRepo', () => {
  test('prefixes bare shortnames with thinmansoftware', () => {
    expect(resolveGithubRepo('shopops')).toBe('thinmansoftware/shopops');
  });

  test('preserves owner/repo', () => {
    expect(resolveGithubRepo('thinmansoftware/lspro-react')).toBe('thinmansoftware/lspro-react');
  });
});

describe('findWoClaim', () => {
  test('prefers MERGED over OPEN', async () => {
    const claim = await findWoClaim({
      woId: 'WO-TEST-CLAIM-01',
      project: 'shopops',
      lookup: async () =>
        [
          {
            number: 1,
            state: 'OPEN',
            title: 'WO-TEST-CLAIM-01 open',
            url: 'https://example/1',
            repo: 'thinmansoftware/shopops',
          },
          {
            number: 2,
            state: 'MERGED',
            title: 'WO-TEST-CLAIM-01 merged',
            url: 'https://example/2',
            repo: 'thinmansoftware/shopops',
          },
        ] satisfies WoClaim[],
    });
    expect(claim?.number).toBe(2);
    expect(claim?.state).toBe('MERGED');
  });

  test('returns null when no exact claim', async () => {
    const claim = await findWoClaim({
      woId: 'WO-TEST-CLAIM-01',
      project: 'shopops',
      lookup: async () => [],
    });
    expect(claim).toBeNull();
  });
});
