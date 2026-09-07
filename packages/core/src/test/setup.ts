// Global test setup for bun:test
import { afterEach, afterAll, setDefaultTimeout } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// PRODUCTION-DB SAFETY GUARD (anchor: 2026-07-21, two production DB wipes).
//
// Inside the Archon container, getArchonHome() resolves to /.archon -- the
// SAME directory the live Archon server uses for its production archon.db.
// A WO's test suite runs inside that same container. Any test that opens the
// real (unmocked) getDatabase()/SqliteAdapter therefore opens the LIVE
// production database, and destructive test fixtures (schema resets, deletes
// against tables the app treats as append-only) wiped it twice in one day.
//
// Fix: force every test process onto an isolated, per-process ARCHON_HOME
// BEFORE any test file's imports run (this file is bunfig.toml's global
// `preload`, so it executes first). getArchonHome() (packages/paths) now
// honors ARCHON_HOME even inside Docker, so this override actually takes
// effect in the container, not just locally.
if (!process.env.ARCHON_HOME || process.env.ARCHON_HOME === 'undefined') {
  process.env.ARCHON_HOME = mkdtempSync(join(tmpdir(), 'archon-test-home-'));
}

// Clean up mocks after each test
afterEach(() => {
  // Bun uses mock.restore() for individual mocks
  // For Jest compatibility, we clear any module mocks here
});

// Restore all mocks after all tests complete
afterAll(() => {
  // Reset any global state
});

// WINDOWS CI TIMEOUT CLASS (anchor: 2026-08-25, sighted on #701, #703, #705,
// #710 twice, and #722).
//
// Bun's default per-test timeout is 5000ms. On windows-latest runners, a test
// that is FIRST IN ITS FILE pays module resolution + config cold-start plus
// real filesystem IO on top of its own work, and lands just over that line --
// e.g. the smart-cauldron cascade auth-binding guard measured ~5016ms against
// the 5000ms default. Ubuntu was always green: this is runner speed, not a
// product defect, and the tests are correct.
//
// Patching each test as it flakes does not close the class -- the next
// cold-start-heavy first-in-file test crosses the same line. So the default is
// raised globally here instead. This preload runs before every `bun test`
// invocation (bunfig.toml `preload`), so local and CI agree by construction.
//
// NOTE: bunfig.toml's `[test] timeout` key is NOT honored by Bun 1.3.13
// (verified: a 7s test still failed at 5000ms with `timeout = 12000` set), and
// per-invocation `--timeout` would have to be repeated across ~60 `bun test`
// commands in the package scripts. setDefaultTimeout() in the shared preload is
// the only option that is both effective and single-source.
//
// 30s is generous for a slow runner but still well inside the job-level
// timeout, so a genuinely hung test is still caught and reported as a failure.
//
// Confirmed 2026-09-07: setDefaultTimeout() governs beforeEach/afterEach hooks
// too, not only test bodies (a 7s hook with no explicit timeout argument passes
// under this setting). So the sqlite suites' hooks already have this same 30s
// budget, and per-file hook-timeout arguments are belt-and-braces, not the
// thing standing between them and a green Windows run.
setDefaultTimeout(30_000);

// WINDOWS SQLITE HOOK-TIMEOUT CLASS (anchor: 2026-09-07, sighted on run
// 34119038672 / PR #777 -- tm_control DAL setPauseState + HARD_PAUSE failing at
// 39.9s and 45.4s wall clock; run 34139279393 / PR #772 -- tm_journal DAL
// fire_cauldron at 9140ms; dev run 34117122158 -- dispatch-migration-smoke).
//
// Symptom: windows-latest fails on a DIFFERENT sqlite-backed test each run,
// always with "a beforeEach/afterEach hook timed out for this test", always
// green on ubuntu and green locally.
//
// Cause is contention, not any single slow call. Every test in these suites
// opens a fresh SqliteAdapter in beforeEach (a full 49-table initSchema()) and
// closes it in afterEach. The package "test" script used to run ~21 files in a
// SINGLE `bun test` invocation, and bun runs the files in that invocation
// concurrently in one process -- so a dozen suites hammered create/checkpoint/
// close/unlink on the same filesystem at once.
//
// Measured on a fast local desktop, worst single adapter-open hook:
//     1 process  ->  119ms
//    14 processes -> 2223-3193ms      (a ~26x contention multiplier)
// A windows-latest runner is several times slower again on IO, which carries
// the worst case across the 30s hook budget -- and because it is a race, a
// different test loses it on each run. That is the whole signature.
//
// Fix: the sqlite-heavy files (workflows, dispatch, taskmaster, overseer,
// board-authority) now run as their own sequential `bun test` invocations in
// packages/core/package.json instead of inside the big concurrent group. Serial
// keeps the worst hook at ~119ms -- a ~250x margin under the 30s budget.
//
// If these files are ever folded back into one shared invocation, this class
// comes back. Note also that the forced Bun.gc(true) in SqliteAdapter.close()
// is NOT the cost here (~3ms/close, measured) and must not be removed -- it is
// what prevents EBUSY on rmSync after close on Windows.
