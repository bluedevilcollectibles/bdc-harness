## Summary
- Opens the CGC streamed session on the seller's own first cert (`buildCertUrl(certNumbers[0])`), not the fixture cert, and drops the unattended `registerPostCapture` batch registration.
- Adds a NO-navigation current-page read: `connect-agent` `GET /session/:id/page` -> `sessionManager.readSessionPage`, wired through `browserAgentClient.sessionPage` and `cgc.js`'s `readCurrentCert`.
- `sessionNavigate`'s settle cap raised 60s -> 90s (`Math.min(settle.timeoutMs, 90000)`), with new `challenged`/`polls` fields.
- `createReplaySession` now launches through the SAME shared `launchCaptureBrowser()` helper capture uses (same headless mode, launch args, viewport/locale/timezone) instead of a bare `headless: true` default-context launch -- fixes the vault-replay fingerprint mismatch that caused every replay to be auto-revoked.
- New `shopops-api` routes (desktop + mobile twins): `POST .../cgc/session/:id/current`, `POST .../cgc/session/:id/next` (ledger-check-first, no navigation on a cache hit), `POST .../cgc/session/:id/close` (vault collect + `m157_instrument` clicks-per-slab structured log line).

### Security fixes (two [major] Overseer findings)
1. **Capture-session ownership** (fixed in `1fd912b`): `captureService.pendingSessions` is process-global and keyed by an agent-issued id, so a session id alone was enough to read, navigate or close someone else's session; `/close` did not check at all before `getCaptureStatus`. Sessions started through these routes are now bound to their creator (desktop: staff tenant; mobile: tenant + scan session id) in a router-owned registry, every session-scoped route (`current`, `next`, `close`, `status`) checks it BEFORE any capture action, and unknown or foreign ids answer `404` (never `403` -- no existence oracle).
2. **Ledger poisoning via an unverified cert / page** (fixed in this head): `/current` and `/next` accepted any `certNumber`, and `/current` treated ANY page carrying the generic record marker as the requested cert, then cached it under the caller-supplied number (`parseCgcHtml` stamps `cert_number` from its argument, so the parsed record could never disagree). Fixed two ways: (a) the owner binding now also carries the `certNumbers` batch the session was opened with, and a cert outside it is refused `403 cert_not_in_session_batch` before the page is read or navigated; (b) `readCurrentCert` and `navigateToCert` now report the page `url` they actually read or settled on, and the route compares the cert parsed out of that url against the requested cert -- a mismatch, or a record page with no url, returns `409 cert_page_mismatch` and the ledger write never happens.

## Test plan
- [x] `cd connect-agent && node tests/test_session_navigate.js && node tests/test_session_page.js && node tests/test_replay_profile.js` -- exit 0 (7+5+2 tests)
- [x] `cd shopops-api && node tests/test_m157_stream_stays_open.js` -- 27/27 passing (16 original + 4 ownership + 7 new finding-1 security tests)
- [x] `cd shopops-api && node tests/test_scan_to_list_cgc.js` -- 29/29 passing
- [x] `cd shopops-api && node tests/run_all.js --suite=m157` -- 10/10 suites passing
- [x] `cd shopops-api && node tests/test_cgc_provider.js` -- 15/15 passing (provider `url` passthrough)
- [x] `cd shopops-api && node tests/test_connect_capture.js` -- 7/7; `node tests/test_capture_fetch_then_collect.js` -- 3/3
- [x] All 8 WO stop-condition greps pass (see manifest)
- [x] ASCII scan clean on all listed files
- [ ] Post-merge runtime verification against `shopops-api-staging` / `connect-agent` containers -- operator-run (Rule 19), not part of this PR

🤖 Generated with [Claude Code](https://claude.com/claude-code)


Closes thinmansoftware/bdc-xo#1887

## Validation (XO, re-run on this head after both [major] Overseer security findings were fixed)

```
WO: WO-SHOPOPS-M157-STREAM-STAYS-OPEN-01
Builder: Smart Cauldron (bdc-feature-development, run c2059370); Overseer security findings fixed and stop conditions re-verified by XO on this head
Files modified: connect-agent/server.js
Files modified: connect-agent/sessionManager.js
Files modified: connect-agent/CONTRACT.md
Files modified: connect-agent/tests/test_session_navigate.js
Files modified: shopops-api/routes/scan-to-list.js
Files modified: shopops-api/services/connect/providers/cgc.js
Files modified: shopops-api/services/connect/browserAgentClient.js
Files modified: shopops-api/tests/run_all.js
Files modified: shopops-api/tests/test_scan_to_list_cgc.js
Files modified: shopops-api/docs/evidence/m157-source-verification.md
Files created: connect-agent/tests/test_session_page.js
Files created: connect-agent/tests/test_replay_profile.js
Files created: shopops-api/tests/test_m157_stream_stays_open.js
Tests: 34/34 (cd shopops-api && node tests/test_m157_stream_stays_open.js), 29/29 (cd shopops-api && node tests/test_scan_to_list_cgc.js), 10/10 suites (cd shopops-api && node tests/run_all.js --suite=m157), 17/17 (cd shopops-api && node tests/test_cgc_provider.js), 7/7 (cd shopops-api && node tests/test_connect_capture.js), 3/3 (cd shopops-api && node tests/test_capture_fetch_then_collect.js), 8/8 (cd connect-agent && node tests/test_session_navigate.js), 5/5 (cd connect-agent && node tests/test_session_page.js), 2/2 (cd connect-agent && node tests/test_replay_profile.js)
PRs: https://github.com/thinmansoftware/shopops/pull/662, <merged timestamp>, <merge commit>
Merge ancestors:
 - thinmansoftware/shopops staging HEAD: fff129fc (WO-SHOPOPS-M157-STAGING-SPLIT-01 merged) | manifest commit: 817ad67 | behind_by: 0
 - WO-SHOPOPS-M157-STAGING-SPLIT-01 merged head: fff129fc
Grep assertions:
 - grep -c "url: currentPageUrl()" connect-agent/sessionManager.js => 2
 - grep -c "'/session/:id/page'" connect-agent/server.js => 1
 - grep -c "function launchCaptureBrowser" connect-agent/sessionManager.js => 1
 - grep -c "headless: true" connect-agent/sessionManager.js => 0
 - grep -c "Math.min(settle.timeoutMs, 90000)" connect-agent/sessionManager.js => 1
 - grep -c "registerPostCapture(" shopops-api/routes/scan-to-list.js => 0
 - grep -c "'/cgc/session/:id/next'" shopops-api/routes/scan-to-list.js => 2
 - grep -c "'/cgc/session/:id/current'" shopops-api/routes/scan-to-list.js => 2
 - grep -c "m157_instrument" shopops-api/routes/scan-to-list.js => 1
 - grep -c "bindSessionOwner(" shopops-api/routes/scan-to-list.js => 3
 - grep -c "sessionOwnedBy(" shopops-api/routes/scan-to-list.js => 9
 - grep -c "certInSessionBatch(" shopops-api/routes/scan-to-list.js => 3
 - grep -c "certNumberFromPage(" shopops-api/routes/scan-to-list.js => 3
 - grep -c "rejectCertPageMismatch(" shopops-api/routes/scan-to-list.js => 3
 - grep -c "cert_not_in_session_batch" shopops-api/routes/scan-to-list.js => 2
 - grep -c "url: landedUrl" shopops-api/services/connect/providers/cgc.js => 3
 - grep -c "url: result.url" shopops-api/services/connect/providers/cgc.js => 1
 - grep -c "SECURITY " shopops-api/tests/test_m157_stream_stays_open.js => 11
Runtime verification: N/A -- operator-run after merge (rebuild shopops-api-staging + connect-agent from staging; docker exec grep -c "/cgc/session/:id/next" /app/routes/scan-to-list.js -> 2; docker exec connect-agent grep -c "/session/:id/page" /app/server.js -> 1)
Vercel deployment: N/A -- shopops-api is not Vercel-deployed
Invocation documented at: connect-agent/CONTRACT.md (GET /session/:id/page, challenged/polls fields) + shopops-api/docs/evidence/m157-source-verification.md (/current, /next, /close, m157_instrument)
VALIDATION: PASS
```








**Overseer at 673b074, two findings.**
1. *No client consumes /current, /next, /close in this PR.* By design: this is step 2 of the M-157 train (WO-SHOPOPS-M157-STREAM-STAYS-OPEN-01); the client is step 3, WO-LSPRO-M157-STREAM-STAYS-OPEN-UI-01 (bdc-xo #1889, spec on main, `depends_on` this WO). The old flow keeps working end-to-end at this head: `POST /cgc/run` (desktop and mobile) and `GET /cgc/session/:id/status` are unchanged, and `/status` reads the agent state without collecting the jar (it runs before `collectSessionCookies`). The current staging UI (status -> cleared -> /cgc/run) therefore does not break when this merges; #1889 moves it onto the new endpoints. Covered by the existing /cgc/run tests in `test_scan_to_list_cgc.js`.
2. *Body and landed URL read without per-session serialization.* Fixed: `connect-agent/sessionManager.js` now serializes `sessionNavigate` and `readSessionPage` per session (`withSessionLock`, a promise chain keyed by session id), and `readSessionPage` takes an atomic snapshot (url before and after `content()`, re-read on drift). New agent test: a read racing a navigate on the same session resolves after the navigate with the navigated page's body AND url, never a mixed pair.


**Overseer at 7d94187 (fixed):** `certNumberFromPage` now parses the landed URL and accepts only https on www.cgccomics.com / cgccomics.com with an exact `/certlookup/<cert>/` path; any other origin yields no cert number, so /current and /next answer 409 `cert_page_mismatch` and never write the ledger. Test: foreign host, plain http, look-alike subdomain, nested path all rejected; the real host passes. Grep: `grep -c "CGC_CERT_PAGE_HOSTS" shopops-api/routes/scan-to-list.js => 2`.



**Overseer at ceb5115, two findings (fixed).**
1. *Ownership binding in a process-local Map.* The binding now lives on the SAME pending-session entry as the agent backend (`captureService.setPendingSessionOwner` / `getPendingSessionOwner`; the route's `ownerStore` uses them, `deps.sessionOwners` stays the test seam). One registry, one lifetime: an owner can never be missing where the backend is found, and a restart drops both together, after which the client re-opens a session exactly as it must for the agent session itself. The session layer is single-process by design (staging = one `node index.js` container, no replicas; the connect-agent's own session table is process-local); this PR keeps ownership exactly as durable and exactly as local as the backend mapping it guards. Test: without the seam, create -> /current with the same tenant resolves the owner from the pending entry.
2. *navigateToCert collapsed every non-record result into challenged.* It now returns `status: record | challenge | other`; `challenge` only when the agent classified the body as a challenge (`result.challenged === true`); `/next` answers `other` with 409 `wrong_page` and never writes the ledger, instead of 202-ing the client into a retry loop. Tests: provider (record / challenge / other) and route (other -> 409, nothing cached).
Greps: `grep -c "getPendingSessionOwner" shopops-api/routes/scan-to-list.js => 1`, `grep -c "status: 'other'" shopops-api/services/connect/providers/cgc.js => 2`.


