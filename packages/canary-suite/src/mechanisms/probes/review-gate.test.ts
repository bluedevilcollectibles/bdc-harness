import { expect, test } from 'bun:test';
import { probeReviewGate } from './review-gate';
test('zero ingests with open PRs fails and names repo and count', async () => {
  const result = await probeReviewGate(async () => [
    { repo: 'shopops-comic-theme', openPrCount: 1, recentIngestCount: 0 },
  ]);
  expect(result.verdict).toBe('failed');
  expect(result.reasonCodes[0]).toContain('shopops-comic-theme:open_prs=1');
});
