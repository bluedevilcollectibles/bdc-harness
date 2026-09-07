John's walk rulings 2026-09-02 (M-157 desktop walk, B5 / B8 / B9) against staging. Plain English: the Comic Card a seller opens from Step 3 becomes the rich card for EVERY row (Open CGC lookup, paste the CGC page, Fill from pasted page, CGC scans vs My photos, graded block), a cert typed on one book can no longer leak onto the next book, and saving the card never blanks a field or touches a price the seller did not change.

What changes (staging only -- lspro-react `staging` branch, Vercel project lspro-react):
- `CEStep03ReviewPrice.tsx`: the thin `CEComicCard` is gone; Step 3 mounts ONE modal for every row, `CEComicCardModal` (ported from promotion/ce with `cgcPageParse`, `SellerPhotoGallery`, `sellerPhotos`). There is no per-row modal selection anywhere.
- Cert leak (B9, cert 4585905005 on the wrong book): `CEComicCardModal` reset every CGC field on row switch EXCEPT the typed cert (`manualCert`), so one row's cert rode into the next row's card and was written by `cgcSaveUpdates` on save. `setManualCert('')` is now in the `[row?.id]` reset effect.
- Merge-only save (B9): title / description / cover are written only when non-empty; `price_cents` is written ONLY when the seller changed the price in the card (`priceDirty`). A user-set price is pricing-hierarchy tier 1 and nothing the card does overrides it.
- B8: verification-pending rows count in the Step 3 summary and stay out of bulk-remove (`removableAttention`, re-land of 7833f11 from promotion/ce).
- `src/components/ce/CEComicCard.tsx` (the thin card) is removed in this PR; `grep -rl "from './CEComicCard'" src` => 0 is the assertion for it.
- Bulk-remove (Overseer finding at 3e289a2): the handler now removes only the rows the count promises -- `needs_attention` rows that are NOT `verification_status: 'pending'`; new tests cover a pending slab beside a removable row, and the Graded filter (the sweep iterates visibleRows, the same collection as the count -- Overseer finding at a6da0ec).
- Overseer at 5900f3f (two findings, both fixed): the CGC paste fallback is gated on `verification_status !== 'verified'` as well as `!cert_found` (a verified row never shows paste, whatever `cert_found` says); series / issue / publisher / year are editable inputs again (`card-series-input`, `card-issue-input`, `card-publisher-input`, `card-year-input`) -- the thin card had them and the rich card must not regress the correct-the-metadata workflow -- and they save merge-only (a blanked field is not written).
- Overseer at 58fac66 (fixed): the slab's "CGC scans" view now reads the front scan (typed, pasted, or already on the row as `image_front_url` / `slab_image_url`) for the preview and for readiness, so a slab with scans is no longer "No slab image yet" or held in needs_attention for its image; the scan inputs are seeded from the row on reopen; on save the scan stands in for a missing/placeholder cover but never replaces a real one (John, 2026-08-29).
- Overseer at 8b099a1 (fixed): the CGC-scans view never presents a stock cover AS a scan -- a slab with a seller-chosen cover and no scan shows the cover with the caption "Stock cover -- no CGC scan yet" (`card-slab-cover-fallback`). Readiness rule, now written into the component: a real listing image is a seller photo, the CGC scan, or a cover the SELLER chose in the card; "a slab never auto-takes a stock cover" is about the import cascade, not the seller's own choice (John, 2026-08-29: cover over scan).
- Test ids `ce-comic-card`, `card-title-input`, `card-save`, `card-find-images` added to the modal so the existing Step 3 contract tests run against the rich card; the image-search test switches to the stock tab first because the rich card opens on My photos when the row already carries a seller photo.

DO-NOT-TOUCH SURFACE (John, 2026-09-02): CE production is https://ce.livesellerpro.app = Vercel project lspro-react-ce, production branch `release/ce`. This PR targets `staging` and cannot reach that project. No backport, promotion, or rebase onto `release/ce` without a recorded board motion (M-09).

Tests: `npx vitest run src/components/ce src/lib/scan` -> 217/217 (23 files); `npx tsc --noEmit` exit 0; ASCII scan of every ported file clean.

Reconcile-Skip: WO-LSPRO-M157-STREAM-STAYS-OPEN-UI-01

```
WO: WO-LSPRO-M157-STREAM-STAYS-OPEN-UI-01
Builder: XO (walk-ruling fix B5/B8/B9 on staging; pre-step for the WO named above)
Files modified: src/components/ce/CEStep03ReviewPrice.tsx, src/components/ce/CEStep03ReviewPrice.test.tsx
Files created: src/components/ce/CEComicCardModal.tsx, src/components/ce/CEComicCardModal.test.tsx, src/components/comic-card/SellerPhotoGallery.tsx, src/lib/scan/cgcPageParse.ts, src/lib/scan/cgcPageParse.test.ts, src/lib/sellerPhotos.ts
Tests: 217/217 (npx vitest run src/components/ce src/lib/scan); npx tsc --noEmit exit 0
PRs: <this PR>, <merged timestamp>, <merge commit>
Merge ancestors:
 - thinmansoftware/lspro-react staging HEAD: fc4ac1b | manifest commit: 06ab266 | behind_by: 0
Grep assertions:
 - grep -c "setManualCert('')" src/components/ce/CEComicCardModal.tsx => 1
 - grep -c "priceDirty" src/components/ce/CEComicCardModal.tsx => 2
 - grep -c "CEComicCardModal" src/components/ce/CEStep03ReviewPrice.tsx => 2
 - grep -c "removableAttention" src/components/ce/CEStep03ReviewPrice.tsx => 3
 - grep -c "verification_status !== 'pending'" src/components/ce/CEStep03ReviewPrice.tsx => 2
 - grep -c "visibleRows.forEach" src/components/ce/CEStep03ReviewPrice.tsx => 1
 - grep -c "row.verification_status !== 'verified' && (" src/components/ce/CEComicCardModal.tsx => 1
 - grep -c 'card-year-input' src/components/ce/CEComicCardModal.tsx => 1
 - grep -c "var slabScan" src/components/ce/CEComicCardModal.tsx => 1
 - grep -c 'card-slab-cover-fallback' src/components/ce/CEComicCardModal.tsx => 1
 - grep -c 'data-testid="ce-comic-card"' src/components/ce/CEComicCardModal.tsx => 1
 - grep -rl "from './CEComicCard'" src | wc -l => 0
Runtime verification: N/A (CODE class); after merge XO verifies the served staging CEWizardPage chunk contains "Open CGC lookup" and "Fill from pasted page" and that the served ce.livesellerpro.app chunk still contains neither
Vercel deployment: pending merge to staging (Vercel Git integration, project lspro-react -> staging.livesellerpro.app); project lspro-react-ce (ce.livesellerpro.app) untouched
Invocation documented at: N/A -- no new invocation surface
VALIDATION: PASS
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)

