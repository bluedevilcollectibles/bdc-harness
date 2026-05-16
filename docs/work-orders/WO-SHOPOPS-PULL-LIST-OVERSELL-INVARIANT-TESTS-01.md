# WO-SHOPOPS-PULL-LIST-OVERSELL-INVARIANT-TESTS-01 — Pull-List Oversell Invariant Tests

**WO ID:** WO-SHOPOPS-PULL-LIST-OVERSELL-INVARIANT-TESTS-01
**Priority:** P0
**Builder:** Codex
**Repo:** shopops-api
**GitHub Issue:** #127
**Status:** To Do
**Created:** 2026-05-16
**Reference:** wo-recipe.md (12-section format)

---

## 1. Objective

Implement the 12 required invariant tests from plan doc Section 10. These tests constitute the
complete regression suite for the pull-list engine — every test must pass before any pull-list
WO can be considered production-safe.

Deliver:
1. `shopops-api/tests/oversell-invariants.test.js` containing all 12 tests.
2. All 12 tests passing against staging Supabase with real data fixtures.
3. CI configuration ensuring the suite runs on every PR to `shopops-api/main`.

The 12 tests are (from plan doc Section 10):
1. Subscription creates issue-level pulls
2. FOC demand aggregates from pulls
3. Allocation satisfies priority tiers
4. Reserved quantity never exceeds on-hand
5. Safe availability subtracts reserved inventory
6. Storefront catalog never maps available_qty from raw on_hand_qty
7. Storefront checkout cannot buy reserved inventory
8. POS checkout cannot sell reserved inventory
9. WhatNot/eBay/Shopify export cannot list reserved inventory
10. Billing cannot charge from raw pulls without allocation linkage
11. Customer identity mapping prevents duplicate cross-channel customer rows
12. DA cannot mutate canonical state directly

**What behavior exists AFTER this WO?**
After this WO, the full 12-test invariant suite runs on every CI run for `shopops-api`. Any
regression in the pull-list engine or oversell protection is caught before merge. All prior
pull-list WOs are considered regression-tested from this point.

---

## 2. Behavior Source of Truth

Primary plan document:
`docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Section 10 (Required Tests) and related sections: 4 (Customer Identity), 5 (Safe Availability),
5.6 (Checkout), 6 (Channel Contract).

All 12 test scenarios, invariant definitions, and expected behaviors in this WO derive
exclusively from that plan document. No tests are invented.

Secondary references:
- `wo-recipe.md` — 12-section WO template (authoring compliance)
- `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 10 and
  cross-sections 4, 5, 5.5, 5.6, 6 (canonical test requirements)

**Where is the source of truth?**
The plan document at `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Section 10 is authoritative for which tests are required and what each must assert. The Supabase
staging schema is ground truth for actual column names — verify with `information_schema`.

---

## 3. Prior Art Check

**Plan document consulted:** `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Section 10 (Required Tests).

Builder MUST verify that all prior pull-list WOs are at REVIEW or DONE before writing tests,
since this WO depends on all tables and services being implemented:

```bash
# Check that required tables exist in staging
psql "$SUPABASE_DB_URL" -c "
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'customers', 'customer_identity_bindings',
    'inventory_items', 'allocations', 'pull_requests',
    'storefront_orders'
  )
ORDER BY table_name;"

# Check for any existing oversell test file
ls shopops-api/tests/oversell-invariants.test.js 2>/dev/null \
  && echo "EXISTING — read before overwriting" || echo "NEW — safe to create"

# Find existing test patterns to follow
ls shopops-api/tests/*.test.js 2>/dev/null | head -10
```

---

## 4. System Context

**Owner:** Blue Devil Collectibles (BDC) engineering team — Major Build executes, General
approves architecture.

**Repo:** `bluedevilcollectibles/shopops-api` (Node.js ES modules, Supabase/PostgreSQL)

**Dependencies this WO requires (ALL must be REVIEW or DONE):**
- `WO-SHOPOPS-CUSTOMER-IDENTITY-BINDING-01` (#112) — `mapCustomerIdentity`, `customer_identity_bindings` table
- `WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01` (#113) — `safe_available_qty` function, `inventory_items` table
- `WO-SHOPOPS-PULL-LIST-CUSTOMER-PULL-MODEL-01` (#115) — `pull_requests` table, subscription→pull logic
- `WO-SHOPOPS-PULL-LIST-ALLOCATION-ENGINE-01` — `allocations` table, allocation engine
- `WO-SHOPOPS-PULL-LIST-FULFILLMENT-HANDOFF-01` — fulfillment status
- `WO-STOREFRONT-CHECKOUT-VIA-SHOPOPS-ORDER-01` (#123) — `storefront_orders` table, checkout guard
- `WO-SHOPOPS-EXPORT-QTY-AUDIT-01` (#124) — export paths identified (some tests assert on exports)
- GitHub CLI (`gh`) authenticated to `bluedevilcollectibles` org
- Docker container `shopops-api` running on BDC server (for Rule 19 runtime verify)

**Adjacent WOs in the same sprint:**
- This is the final WO in the pull-list engine sprint — it tests all prior WOs collectively

**Who owns this system?**
Blue Devil Collectibles. John Ranson is the sole release authority. General (ChatGPT) owns
architecture decisions. Major Build (Claude Code / Codex) owns execution.

**What MUST NEVER break? (invariants)**
1. `reserved_qty` MUST NEVER exceed `on_hand_qty` in `inventory_items` — a negative
   `safe_available_qty` is always a data error.
2. Storefront, POS, and channel exports MUST NEVER expose raw `on_hand_qty` as sellable quantity.
3. Billing MUST NEVER charge a customer from a raw pull request without an allocation linkage.
4. Customer identity mapping MUST prevent two canonical customer rows for the same natural person
   across channels — the `(tenant_id, source, external_id)` unique constraint is inviolable.
5. DA (Data Access layer / channel integrations) MUST NEVER directly INSERT or UPDATE canonical
   tables — all mutations go through service functions.
6. All 12 tests MUST use real staging data and real staging Supabase — no mock database per
   Rule 16.

---

## 5. UI Hierarchy

No UI changes in this WO. This is a pure test implementation WO. The test output is consumed by:

1. **CI (GitHub Actions)** — `bun test tests/oversell-invariants.test.js` on every PR
2. **Captain CI review** — test results included in the manifest under VALIDATION: PASS
3. **Management UI (WO-MGMT-UI-PULL-LIST-VIEWS-01)** — tests indirectly validate the data
   that the management UI displays

Reference: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 10.

---

## 6. Mode Behavior Matrix

| Test # | Invariant Being Tested | Pass Condition | Fail Condition |
|---|---|---|---|
| 1 | Subscription creates issue-level pulls | `pull_requests` rows exist for each subscribed issue | No pull rows created after subscription |
| 2 | FOC demand aggregates from pulls | FOC demand count = sum of subscriber pulls for that issue | FOC demand differs from pull count |
| 3 | Allocation satisfies priority tiers | Higher-tier subscribers allocated before lower-tier | Lower-tier subscriber allocated first |
| 4 | Reserved qty never exceeds on_hand | `reserved_qty <= on_hand_qty` for all inventory rows | Any row where `reserved_qty > on_hand_qty` |
| 5 | Safe availability subtracts reserved | `safe_available_qty = max(0, on_hand_qty - reserved_qty - channel_listed_elsewhere_qty)` | `safe_available_qty` differs from formula |
| 6 | Storefront catalog never exposes raw on_hand | Catalog API returns `safe_available_qty` field | Catalog API returns `on_hand_qty` as availability |
| 7 | Storefront checkout cannot buy reserved | Checkout returns 409 when all qty is reserved | Checkout succeeds against reserved inventory |
| 8 | POS checkout cannot sell reserved | POS sale returns error when all qty is reserved | POS sale succeeds against reserved inventory |
| 9 | Channel exports cannot list reserved | Export quantity <= `safe_available_qty` | Export quantity > `safe_available_qty` |
| 10 | Billing cannot charge from raw pulls | Billing call fails without allocation linkage | Billing call succeeds with only raw pull reference |
| 11 | Customer identity prevents duplicates | Same natural person across channels → one `customer_id` | Two `customer_id` rows for same person |
| 12 | DA cannot mutate canonical state | Direct INSERT to canonical table returns error | Direct INSERT succeeds |

**What happens if it runs twice? (idempotency)**
The test suite uses isolated test data fixtures with unique identifiers (generated UUIDs) for
each run. Each test cleans up its own fixtures in `afterEach` / `afterAll`. Running the suite
twice produces identical results. The invariant assertions are read-only checks — they do not
create persistent state changes.

---

## 7. Backend Function Inventory

All items below are either NEW test code or EXISTING service functions being called by tests.

| Item | File | Status | Notes |
|---|---|---|---|
| `oversell-invariants.test.js` | `tests/oversell-invariants.test.js` | NEW | Contains all 12 tests |
| `seedTestFixtures(tenantId)` | `tests/helpers/fixtures.js` | NEW or EXISTING (builder MUST verify) | Creates test tenants, inventory, subscriptions |
| `cleanupTestFixtures(tenantId)` | `tests/helpers/fixtures.js` | NEW or EXISTING | Deletes test data after suite |
| `mapCustomerIdentity` | `services/customerIdentity.js` | EXISTING (per WO-SHOPOPS-CUSTOMER-IDENTITY-BINDING-01) | Called by test 11 |
| `safe_available_qty` function | `services/inventory.js` | EXISTING (per WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01) | Called by tests 4, 5 |
| Checkout guard | `shopops-storefront/src/services/orderService.js` | EXISTING (per WO-STOREFRONT-CHECKOUT-VIA-SHOPOPS-ORDER-01) | Called via API by test 7 |
| POS checkout route | `routes/pos/checkout.js` | EXISTING (builder MUST find actual file:line) | Called via API by test 8 |
| Channel export handlers | `src/exports/*.js` | EXISTING (builder MUST find actual file:line) | Called by test 9 |
| Billing service | `services/billing.js` | EXISTING (builder MUST find actual file:line) | Called by test 10 |
| DA / data access layer | `db/` or `models/` | EXISTING (builder MUST find actual structure) | Test 12 attempts direct INSERT and expects failure |

---

## 8. Data Flow

```
Test suite bootstraps:
  seedTestFixtures(TEST_TENANT_ID)
  |
  +-- Creates: tenant, customers, inventory items, subscriptions, pull requests, allocations
  |
  v

Per test:

Test 4 (reserved <= on_hand invariant):
  SELECT on_hand_qty, reserved_qty FROM inventory_items WHERE tenant_id = TEST_TENANT_ID
  --> Assert: every row has reserved_qty <= on_hand_qty

Test 5 (safe availability formula):
  SELECT on_hand_qty, reserved_qty, channel_listed_elsewhere_qty, safe_available_qty
  FROM inventory_items WHERE tenant_id = TEST_TENANT_ID
  --> Assert: safe_available_qty = max(0, on_hand_qty - reserved_qty - channel_listed_elsewhere_qty)

Test 6 (storefront catalog not raw):
  GET /api/storefront/catalog?tenant=TEST_TENANT_ID
  --> Assert: response does NOT contain key "on_hand_qty" at top level available field
  --> Assert: response DOES contain "safe_available_qty" or "available_qty" = safe value

Test 7 (storefront checkout blocked):
  SET all inventory reserved (reserved_qty = on_hand_qty for test item)
  POST /api/checkout/orders { cartId, paymentIntentId }
  --> Assert: response status 409

Test 11 (customer identity no duplicates):
  mapCustomerIdentity(TEST_TENANT_ID, 'SHOPIFY', 'shopify_ext_1', { email: 'test@example.com' })
  mapCustomerIdentity(TEST_TENANT_ID, 'WHATNOT', 'whatnot_ext_1', { email: 'test@example.com' })
  SELECT COUNT(DISTINCT customer_id) FROM customer_identity_bindings
  WHERE tenant_id = TEST_TENANT_ID AND customer_id IN (cust1, cust2)
  --> Assert: COUNT = 1 (same customer_id for both channels)

  v

cleanupTestFixtures(TEST_TENANT_ID)
```

**Cross-repo note (bdc-xo):** The spec document lives in `bluedevilcollectibles/bdc-xo`. The
implementation lives in `bluedevilcollectibles/shopops-api`. The YAML workflow fetches the spec
from `bdc-xo` at runtime via `gh api`.

### Grep Assertions (Check 8A)

The following greps MUST pass in the `shopops-api` directory after implementation:

```bash
grep -c "Test [0-9]\|test.*invariant\|it('.*\|describe('.*" \
  shopops-api/tests/oversell-invariants.test.js \
  | awk '{if($1>=12) print "PASS: "$1" tests found"; else {print "FAIL: only "$1" tests found"; exit 1}}'

grep -q "reserved_qty" shopops-api/tests/oversell-invariants.test.js \
  || (echo "FAIL: reserved_qty invariant test missing" && exit 1)

grep -q "safe_available_qty" shopops-api/tests/oversell-invariants.test.js \
  || (echo "FAIL: safe_available_qty test missing" && exit 1)

grep -q "customer_identity_bindings\|mapCustomerIdentity" \
  shopops-api/tests/oversell-invariants.test.js \
  || (echo "FAIL: customer identity test missing" && exit 1)

grep -q "409\|reserved\|blocked\|cannot" shopops-api/tests/oversell-invariants.test.js \
  || (echo "FAIL: checkout/POS block tests missing" && exit 1)

grep -q "cleanupTestFixtures\|afterAll\|afterEach" \
  shopops-api/tests/oversell-invariants.test.js \
  || (echo "FAIL: test cleanup missing — will leave dirty staging data" && exit 1)
```

---

## 9. Database Schema References

This WO reads from all pull-list tables. Builder MUST verify each table and its relevant columns
before writing assertions:

```sql
-- Verify inventory_items columns (tests 4, 5)
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'inventory_items'
  AND column_name IN ('on_hand_qty', 'reserved_qty', 'channel_listed_elsewhere_qty')
ORDER BY ordinal_position;

-- Verify allocations columns (tests 3, 10)
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'allocations'
  AND column_name IN ('allocation_id', 'pull_id', 'customer_id', 'inventory_item_id',
                      'quantity', 'status', 'allocated_at', 'fulfilled_at', 'invoiced_at')
ORDER BY ordinal_position;

-- Verify customer_identity_bindings columns (test 11)
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'customer_identity_bindings'
  AND column_name IN ('binding_id', 'tenant_id', 'customer_id', 'source', 'external_id')
ORDER BY ordinal_position;

-- Verify pull_requests table exists (tests 1, 2)
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'pull_requests';
```

Expected allocation columns per plan doc Section 4:
| Column | Type |
|---|---|
| `allocation_id` | uuid |
| `tenant_id` | uuid |
| `pull_id` | uuid |
| `customer_id` | uuid |
| `inventory_item_id` | uuid |
| `quantity` | integer |
| `status` | text |
| `allocated_at` | timestamptz |
| `fulfilled_at` | timestamptz |
| `invoiced_at` | timestamptz |

Column claims above come directly from plan doc Section 4. Builder MUST run all four
`information_schema` queries above against staging before writing test assertions.

---

## 10. Deploy Target

- **Platform:** `shopops-api` (Node.js, Docker container on BDC server)
- **Environment:** Staging Supabase (all tests run against staging per Rule 16)
- **No migration** — this WO adds tests only; schema is provided by dependency WOs
- **Runtime verify (Rule 19):**
  ```bash
  docker exec shopops-api grep -n "oversell-invariants\|seedTestFixtures" \
    /app/tests/oversell-invariants.test.js 2>&1
  ```
  If the container has not been rebuilt, `STATUS=skipped_container_not_rebuilt` is acceptable
  in the manifest — but the `RULE19_RERUN` command must be included.
- **No production deploy** without John's explicit "PROCEED DEPLOY."

---

## 11. Test Scenarios

The 12 oversell invariant tests are the deliverable. Each is specified below in Given/When/Then
format matching plan doc Section 10.

**Test 1 — Subscription creates issue-level pulls**

Given: a customer `sub_cust_1` is subscribed to series `SERIES_A` with active subscription
When: the subscription engine processes a new issue `ISSUE_A_001` for `SERIES_A`
Then:
- A `pull_requests` row exists for `(sub_cust_1, ISSUE_A_001, SERIES_A)`
- Assert: `SELECT COUNT(*) FROM pull_requests WHERE customer_id='sub_cust_1' AND issue_id='ISSUE_A_001'` = 1

**Test 2 — FOC demand aggregates from pulls**

Given: 3 customers are subscribed to series `SERIES_B`; issue `ISSUE_B_001` has been processed
When: FOC demand is computed for `ISSUE_B_001`
Then:
- FOC demand count = 3
- Assert: FOC demand record for `ISSUE_B_001` has `quantity = 3`

**Test 3 — Allocation satisfies priority tiers**

Given: inventory `ITEM_001` has `on_hand_qty = 2`; customer `TIER1_CUST` has priority tier 1;
  customer `TIER2_CUST` has priority tier 2; both have pull requests for `ITEM_001`
When: allocation engine runs for `ITEM_001`
Then:
- `TIER1_CUST` receives allocation first
- If only 2 units exist, `TIER2_CUST` may receive the second unit
- Assert: allocation for `TIER1_CUST` has `allocated_at` <= allocation for `TIER2_CUST`

**Test 4 — Reserved quantity never exceeds on-hand**

Given: the staging database has live inventory rows for test tenant
When: the following query runs:
  ```sql
  SELECT COUNT(*) FROM inventory_items
  WHERE tenant_id = :testTenantId AND reserved_qty > on_hand_qty
  ```
Then: count = 0 (no rows where reserved exceeds on-hand)

**Test 5 — Safe availability subtracts reserved inventory**

Given: inventory row `ITEM_002` with `on_hand_qty=10, reserved_qty=7, channel_listed_elsewhere_qty=1`
When: `safe_available_qty` is computed for `ITEM_002`
Then:
- Result = `max(0, 10 - 7 - 1)` = 2
- Assert: computed value = 2

**Test 6 — Storefront catalog never maps available_qty from raw on_hand_qty**

Given: `ITEM_003` has `on_hand_qty=5, reserved_qty=5` (fully reserved)
When: `GET /api/storefront/catalog` is called for `ITEM_003`
Then:
- Response does NOT expose `on_hand_qty` as the availability field
- Response availability field = 0 (safe_available_qty = max(0, 5-5) = 0)
- Assert: response `available_qty` or `safe_available_qty` = 0

**Test 7 — Storefront checkout cannot buy reserved inventory**

Given: `ITEM_004` has `on_hand_qty=3, reserved_qty=3` (fully reserved for pull-list)
When: storefront checkout attempts to purchase `ITEM_004`
Then:
- Checkout returns HTTP 409 or equivalent rejection
- No `storefront_orders` row is created for `ITEM_004`

**Test 8 — POS checkout cannot sell reserved inventory**

Given: `ITEM_005` has `on_hand_qty=2, reserved_qty=2` (fully reserved)
When: POS checkout attempts to sell `ITEM_005` to a walk-in customer
Then:
- POS checkout returns an error indicating item is unavailable
- No sale record is created for `ITEM_005`

**Test 9 — WhatNot/eBay/Shopify export cannot list reserved inventory**

Given: `ITEM_006` has `on_hand_qty=4, reserved_qty=4` (fully reserved)
When: the WhatNot export, eBay export, or Shopify inventory sync runs
Then:
- Export quantity for `ITEM_006` = 0 (safe_available_qty = 0)
- Assert: exported quantity <= safe_available_qty

**Test 10 — Billing cannot charge from raw pulls without allocation linkage**

Given: customer `BILL_CUST_1` has a pull request `PULL_001` for `ITEM_007` but NO allocation
  row linking `PULL_001` to actual inventory
When: billing service is called with `PULL_001` as the charge reference
Then:
- Billing service rejects the charge
- Returns an error indicating missing allocation linkage
- Assert: no invoice row created for `PULL_001`

**Test 11 — Customer identity mapping prevents duplicate cross-channel customer rows**

Given: Alice has email `alice_invariant@example.com`; no prior customer record for this email
When: `mapCustomerIdentity(tenantId, 'SHOPIFY', 'shopify_alice', { email: 'alice_invariant@example.com' })`
  is called, then
  `mapCustomerIdentity(tenantId, 'WHATNOT', 'whatnot_alice', { email: 'alice_invariant@example.com' })`
  is called
Then:
- Both calls return the SAME `customer_id`
- Assert: `SELECT COUNT(DISTINCT customer_id) FROM customer_identity_bindings WHERE email_norm='alice_invariant@example.com'` = 1

**Test 12 — DA cannot mutate canonical state directly**

Given: a direct INSERT is attempted on `allocations` table bypassing service layer (e.g., raw
  `db.query('INSERT INTO allocations ...')` without going through the allocation service)
When: the INSERT is executed
Then:
- The operation either throws an error (RLS policy blocks it) or the allocation service
  validation layer rejects it
- The `allocations` table row count does not increase
- Assert: row count in `allocations` before and after attempted direct INSERT is identical

**How does CI prove it works?**
```bash
cd shopops-api && bun test tests/oversell-invariants.test.js
```
All 12 tests must pass. GitHub Actions runs this on every PR to `shopops-api/main`.

---

## 12. Stop Point

WO is REVIEW-eligible when ALL of the following CI-executable commands return 0:

**Stop 1 — Test file exists and contains >= 12 test cases**
```bash
ls shopops-api/tests/oversell-invariants.test.js \
  && echo "PASS: file exists" || (echo "FAIL: test file missing" && exit 1)

grep -c "it(\|test(" shopops-api/tests/oversell-invariants.test.js \
  | awk '{if($1>=12) print "PASS: "$1" tests"; else {print "FAIL: only "$1" tests (need 12)"; exit 1}}'
```

**Stop 2 — All 12 tests pass against staging**
```bash
cd shopops-api && bun test tests/oversell-invariants.test.js
# Exit code 0 and output contains "12 pass"
```

**Stop 3 — Grep assertions pass**
```bash
grep -q "reserved_qty" shopops-api/tests/oversell-invariants.test.js \
  && echo "PASS" || (echo "FAIL: reserved_qty test missing" && exit 1)
grep -q "safe_available_qty" shopops-api/tests/oversell-invariants.test.js \
  && echo "PASS" || (echo "FAIL: safe_available_qty test missing" && exit 1)
grep -q "mapCustomerIdentity\|customer_identity" shopops-api/tests/oversell-invariants.test.js \
  && echo "PASS" || (echo "FAIL: identity test missing" && exit 1)
grep -q "cleanupTestFixtures\|afterAll" shopops-api/tests/oversell-invariants.test.js \
  && echo "PASS" || (echo "FAIL: cleanup missing" && exit 1)
```

**Stop 4 — No dirty staging data left after run**
```bash
# Verify cleanup ran: test tenant data should be absent after suite
psql "$SUPABASE_DB_URL" -c \
  "SELECT COUNT(*) FROM inventory_items WHERE tenant_id='<TEST_TENANT_ID>';" \
  | grep -q "^(0 rows\| 0)" \
  && echo "PASS: cleanup complete" || echo "WARN: test data may remain — verify cleanup"
```

**Stop 5 — Rule 19 runtime verify (best-effort)**
```bash
RESULT=$(docker exec shopops-api grep -n "oversell-invariants\|seedTestFixtures" \
  /app/tests/oversell-invariants.test.js 2>&1)
if [ $? -eq 0 ]; then echo "STATUS=ok"; echo "$RESULT"
else echo "STATUS=skipped_container_not_rebuilt"
     echo "RULE19_RERUN=docker exec shopops-api grep -n 'seedTestFixtures' /app/tests/oversell-invariants.test.js"
fi
```

**Stop 6 — PR opened against shopops-api/main**

Given: all stops 1–5 pass
When: `gh pr view --repo bluedevilcollectibles/shopops-api --json state` is run
Then: output contains `"state":"OPEN"` and PR title includes
  `WO-SHOPOPS-PULL-LIST-OVERSELL-INVARIANT-TESTS-01` and PR body contains `Closes #127`

All 6 stops must be included in the Captain CI manifest under VALIDATION: PASS.
