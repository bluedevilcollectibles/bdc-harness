# WO-SHOPOPS-PULL-LIST-CUSTOMER-PULL-MODEL-01 — Customer Pull Model and Lifecycle

**WO ID:** WO-SHOPOPS-PULL-LIST-CUSTOMER-PULL-MODEL-01
**Priority:** P1
**Builder:** Codex
**Repo:** shopops-api
**GitHub Issue:** #115
**Status:** To Do
**Created:** 2026-05-16
**Reference:** wo-recipe.md (12-section format)

---

## 1. Objective

Build the canonical `customer_pulls` table and its full lifecycle state machine for Shop Ops HQ.
Customer pulls represent demand — a customer's intent to receive a specific issue — not a billing
entitlement. The lifecycle is:

```
REQUESTED -> FOC_LOCKED -> ALLOCATED -> READY_TO_INVOICE -> INVOICED -> SHIPPED / PICKED_UP
                                                                            |
                                                                       CANCELLED (from any state)
```

Deliver:
1. A `customer_pulls` table migration covering all fields from plan doc Section 4.
2. A service `customerPulls.js` with functions to create, transition, and query pulls.
3. A lifecycle validator that enforces legal state transitions.
4. A `reconcilePullAllocation(pullId)` function that checks `safe_available_qty` before
   marking a pull ALLOCATED — never allocate from a pull directly without availability check.
5. A REST API: `POST /api/pulls`, `GET /api/pulls/:pullId`, `PATCH /api/pulls/:pullId/status`.
6. Unit + integration tests covering all lifecycle transitions and the billing invariant.

**What behavior exists AFTER this WO?**
After this WO, pull-list demand is stored in `customer_pulls` with a single authoritative state
per pull. Billing code MUST NOT charge from a pull unless it has reached ALLOCATED or later.
Subscriptions generate pull rows with `subscription_id` populated. No downstream code invents
its own pull record format.

---

## 2. Behavior Source of Truth

Primary plan document:
`docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Section 4 — Customer Pull.

All field names, lifecycle states, transition rules, and billing invariants in this WO derive
exclusively from that plan document. No names are invented.

Secondary references:
- `wo-recipe.md` — 12-section WO template (authoring compliance)
- `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` (canonical spec)

**Where is the source of truth?**
The plan document at `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Section 4 defines all pull fields, lifecycle states, and the billing invariant. Supabase staging
schema is ground truth for actual columns.

---

## 3. Prior Art Check

**Plan document consulted:** `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Section 4, Customer Pull.

No existing `customer_pulls` table found in shopops-api at WO authoring time. Builder MUST run:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('customer_pulls', 'subscriptions');
```

**Blocking dependency:** `customers` table must exist (created by
WO-SHOPOPS-CUSTOMER-IDENTITY-BINDING-01). If `customers` table does not exist, this WO is
BLOCKED — stop and flag to XO immediately.

Existing files to check before starting:
- `shopops-api/db/migrations/` — prior pull or subscription migrations
- `shopops-api/services/pull*` — any existing pull service
- `shopops-api/routes/pull*` — any existing pull route

---

## 4. System Context

**Owner:** Blue Devil Collectibles. John Ranson is sole release authority.

**Repo:** `bluedevilcollectibles/shopops-api`

**Hard dependencies (this WO MUST NOT start until these are met):**
1. `customers` table exists in staging Supabase — provided by
   WO-SHOPOPS-CUSTOMER-IDENTITY-BINDING-01 (#112). Builder MUST verify:
   ```bash
   psql "$SUPABASE_DB_URL" -c "SELECT COUNT(*) FROM customers;" || (echo "BLOCKED: customers table missing" && exit 1)
   ```
2. `inventory_items` table exists — required for allocation check against `safe_available_qty`.
3. `v_inventory_availability` view exists (provided by
   WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01 #113) for `reconcilePullAllocation`. If the view
   is not yet present, allocation can be skipped with a documented TODO and a feature flag
   `AVAILABILITY_CHECK_ENABLED=false`, but the function signature must be in place.

**Adjacent WOs (no schema overlap):**
- WO-SHOPOPS-CUSTOMER-IDENTITY-BINDING-01 (#112) — hard dependency (see above)
- WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01 (#113) — soft dependency for allocation gate

**Who owns this system?**
Blue Devil Collectibles. General owns architecture; Major Build owns execution.

**What MUST NEVER break? (invariants)**
1. **Billing invariant:** No billing code may charge from a pull record unless `status` is
   `ALLOCATED`, `READY_TO_INVOICE`, `INVOICED`, `SHIPPED`, or `PICKED_UP`. This must be
   enforced in a dedicated billing guard function `assertPullBillable(pull)` that throws if
   `status` is `REQUESTED` or `FOC_LOCKED`.
2. **Transition invariant:** Only legal transitions are permitted (see mode matrix §6). An
   attempt to transition from `INVOICED` to `REQUESTED` must throw `IllegalStateTransition`.
3. **Demand vs entitlement invariant:** A pull is demand only. Allocation to a pull must check
   `safe_available_qty >= quantity_requested` before setting status to `ALLOCATED`.
4. **Subscription linkage invariant:** When `subscription_id` is present, the pull must
   reference a valid `subscriptions` row (FK constraint). Orphan pull records are not permitted.
5. **tenant_id isolation:** All queries must always filter by `tenant_id`.

---

## 5. UI Hierarchy

No frontend UI in this WO. Backend service and REST API only. Consumers:

1. **Subscription engine** (future WO) — creates pull rows via `createPull(tenantId, payload)`
   with `subscription_id` populated when generating FOC-date pulls automatically.
2. **POS manual pull entry** — calls `POST /api/pulls` with `request_source = 'POS'`.
3. **LOCG import pipeline** — calls `createPull` for each LOCG pull list record with
   `request_source = 'LOCG'`.
4. **Storefront self-service** — calls `POST /api/pulls` with `request_source = 'STOREFRONT'`.
5. **FOC lock cron** (future WO) — calls `transitionPull(pullId, 'FOC_LOCKED')` for all
   `REQUESTED` pulls whose `foc_date` has passed.
6. **Invoice engine** (future WO) — calls `assertPullBillable(pull)` before charging; calls
   `transitionPull(pullId, 'READY_TO_INVOICE')` when allocation confirmed.
7. **Fulfillment engine** (future WO) — calls `transitionPull(pullId, 'SHIPPED')` or
   `transitionPull(pullId, 'PICKED_UP')` upon dispatch.
8. **REST API** — `GET /api/pulls/:pullId` returns pull state to any authorized caller.
   `PATCH /api/pulls/:pullId/status` for manual overrides (staff only).

Reference: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 4.

---

## 6. Mode Behavior Matrix

### Legal State Transitions

| From | To | Trigger |
|---|---|---|
| `REQUESTED` | `FOC_LOCKED` | FOC date passed — cron or manual lock |
| `REQUESTED` | `CANCELLED` | Customer cancels before FOC lock |
| `FOC_LOCKED` | `ALLOCATED` | `reconcilePullAllocation` succeeds (qty available) |
| `FOC_LOCKED` | `CANCELLED` | Staff cancels after FOC (exceptional) |
| `ALLOCATED` | `READY_TO_INVOICE` | Allocation confirmed, invoice cycle begins |
| `ALLOCATED` | `CANCELLED` | Exceptional cancellation (releases reserved_qty) |
| `READY_TO_INVOICE` | `INVOICED` | Invoice sent |
| `INVOICED` | `SHIPPED` | Physical dispatch recorded |
| `INVOICED` | `PICKED_UP` | Customer in-store pickup recorded |
| `SHIPPED` | (terminal) | — |
| `PICKED_UP` | (terminal) | — |
| `CANCELLED` | (terminal) | — |

**Any transition NOT listed above MUST throw `IllegalStateTransition`.**

### Request Source Enum

| Value | Origin |
|---|---|
| `STOREFRONT` | Customer self-service on storefront |
| `POS` | Staff creates pull at point of sale |
| `SUBSCRIPTION` | Auto-generated from subscription engine |
| `LOCG` | Imported from LOCG pull list file |
| `MANUAL` | Staff-created outside normal channels |

**What happens if it runs twice? (idempotency)**
- `createPull` uses `INSERT ... RETURNING pull_id`. Calling it twice with the same inputs
  creates two separate pull rows (pulls are not inherently idempotent — a customer can have
  multiple pulls for the same issue). Callers that need idempotency MUST first check for an
  existing REQUESTED pull for `(tenant_id, customer_id, issue_id)` before calling `createPull`.
- `transitionPull(pullId, newStatus)` is idempotent for the same transition: if `status`
  is already `newStatus`, it returns the pull unchanged without error.
- Migration uses `CREATE TABLE IF NOT EXISTS` — safe to run twice.

---

## 7. Backend Function Inventory

| Function | File | Status | Notes |
|---|---|---|---|
| `createPull(tenantId, payload)` | `services/customerPulls.js` | NEW | Inserts REQUESTED pull, returns pull_id |
| `transitionPull(tenantId, pullId, newStatus)` | `services/customerPulls.js` | NEW | Validates transition, updates status |
| `getPull(tenantId, pullId)` | `services/customerPulls.js` | NEW | Fetch single pull |
| `listPulls(tenantId, filters)` | `services/customerPulls.js` | NEW | Paginated pull list |
| `reconcilePullAllocation(tenantId, pullId)` | `services/customerPulls.js` | NEW | Checks safe_available_qty, transitions FOC_LOCKED -> ALLOCATED |
| `assertPullBillable(pull)` | `services/customerPulls.js` | NEW | Throws if pull not in billable state |
| `LEGAL_TRANSITIONS` | `services/customerPulls.js` | NEW | Map of allowed from->to transitions |
| `POST /api/pulls` | `routes/pulls.js` | NEW | Create pull (auth required) |
| `GET /api/pulls/:pullId` | `routes/pulls.js` | NEW | Get pull (tenant-scoped) |
| `PATCH /api/pulls/:pullId/status` | `routes/pulls.js` | NEW | Manual transition (staff only) |
| Migration: `customer_pulls` | `db/migrations/YYYYMMDD_customer_pulls.sql` | NEW | Table + indexes |
| Migration: `subscriptions` | `db/migrations/YYYYMMDD_subscriptions.sql` | NEW or EXISTING — builder MUST verify |

Builder MUST check subscriptions table existence before writing its migration:
```bash
psql "$SUPABASE_DB_URL" -c "SELECT COUNT(*) FROM subscriptions;" 2>&1 \
  && echo "EXISTING" || echo "NEW — must create"
```

---

## 8. Data Flow

```
Caller (subscription engine / POS / LOCG / storefront)
  |
  +-- createPull(tenantId, { customer_id, issue_id, subscription_id?,
  |              quantity_requested, foc_date, request_source })
  |     |
  |     v
  |   INSERT INTO customer_pulls (tenant_id, customer_id, issue_id, ...)
  |   VALUES (...) RETURNING pull_id
  |     |
  |     v
  |   Status = REQUESTED
  |
  +-- [FOC date passes] -- transitionPull(tenantId, pullId, 'FOC_LOCKED')
  |     |
  |     v
  |   Validate REQUESTED -> FOC_LOCKED is legal
  |   UPDATE customer_pulls SET status='FOC_LOCKED' WHERE pull_id=$1 AND tenant_id=$2
  |
  +-- reconcilePullAllocation(tenantId, pullId)
  |     |
  |     +-- getSafeAvailability(tenantId, inventoryItemId)
  |     |   [safe_available_qty < quantity_requested] -> throw InsufficientInventory
  |     |   [safe_available_qty >= quantity_requested] -> continue
  |     |
  |     +-- UPDATE inventory_items SET reserved_qty = reserved_qty + quantity_requested
  |     +-- transitionPull(tenantId, pullId, 'ALLOCATED')
  |
  +-- assertPullBillable(pull)  <-- called by invoice engine before any charge
  |     |
  |     [status NOT IN ('ALLOCATED','READY_TO_INVOICE','INVOICED','SHIPPED','PICKED_UP')]
  |       -> throw Error('Pull not billable: status=' + pull.status)
  |
  v
Pull reaches terminal state: SHIPPED / PICKED_UP / CANCELLED
```

**Cross-repo note (bdc-xo):** Spec lives in `bluedevilcollectibles/bdc-xo`. Implementation in
`bluedevilcollectibles/shopops-api`. YAML workflow fetches spec at runtime via `gh api`.

### Grep Assertions (Check 8A — bdc-xo cross-repo)

```bash
grep -r "createPull" shopops-api/services/customerPulls.js | grep -q "." \
  || (echo "FAIL: createPull not found" && exit 1)

grep -r "transitionPull" shopops-api/services/customerPulls.js | grep -q "." \
  || (echo "FAIL: transitionPull not found" && exit 1)

grep -r "assertPullBillable" shopops-api/services/customerPulls.js | grep -q "." \
  || (echo "FAIL: assertPullBillable not found" && exit 1)

grep -r "IllegalStateTransition\|illegal.*state\|invalid.*transition" \
  shopops-api/services/customerPulls.js -i | grep -q "." \
  || (echo "FAIL: illegal transition guard not found" && exit 1)

grep -r "customer_pulls" shopops-api/db/ | grep -q "." \
  || (echo "FAIL: migration not in db/" && exit 1)

grep -r "REQUESTED\|FOC_LOCKED\|ALLOCATED" shopops-api/services/customerPulls.js | grep -q "." \
  || (echo "FAIL: status constants not found" && exit 1)
```

---

## 9. Database Schema References

### `customer_pulls` table (NEW — this WO creates it)

Migration: `shopops-api/db/migrations/YYYYMMDD_customer_pulls.sql`

```sql
CREATE TABLE IF NOT EXISTS customer_pulls (
  pull_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  customer_id           uuid NOT NULL REFERENCES customers(customer_id),
  issue_id              uuid NOT NULL,
  subscription_id       uuid REFERENCES subscriptions(subscription_id),
  quantity_requested    integer NOT NULL CHECK (quantity_requested > 0),
  quantity_allocated    integer NOT NULL DEFAULT 0 CHECK (quantity_allocated >= 0),
  status                text NOT NULL DEFAULT 'REQUESTED'
                          CHECK (status IN (
                            'REQUESTED','FOC_LOCKED','ALLOCATED',
                            'READY_TO_INVOICE','INVOICED',
                            'SHIPPED','PICKED_UP','CANCELLED')),
  foc_date              date,
  request_source        text NOT NULL
                          CHECK (request_source IN (
                            'STOREFRONT','POS','SUBSCRIPTION','LOCG','MANUAL')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_pulls_tenant_customer
  ON customer_pulls (tenant_id, customer_id);

CREATE INDEX IF NOT EXISTS idx_customer_pulls_tenant_issue
  ON customer_pulls (tenant_id, issue_id);

CREATE INDEX IF NOT EXISTS idx_customer_pulls_status
  ON customer_pulls (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_customer_pulls_foc_date
  ON customer_pulls (tenant_id, foc_date) WHERE status = 'REQUESTED';
```

### `subscriptions` table (builder MUST verify existence first)

Fields per plan doc Section 4:
| Column | Type | Nullable |
|---|---|---|
| `subscription_id` | uuid (PK) | NO |
| `tenant_id` | uuid | NO |
| `customer_id` | uuid (FK customers) | NO |
| `series_id` | uuid | YES |
| `status` | text | NO |
| `quantity` | integer | NO |
| `start_date` | date | YES |
| `end_date` | date | YES |
| `preferences` | jsonb | YES |
| `source` | text | YES |

Builder MUST verify with:
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'subscriptions'
ORDER BY ordinal_position;
```

If `subscriptions` does not exist, builder must create its migration in this WO (include both
migrations). Column claims come from plan doc Section 4.

### `customers` table (dependency from WO-SHOPOPS-CUSTOMER-IDENTITY-BINDING-01)

Builder verifies via `information_schema` as described in §4 blocking dependency check.
`customer_pulls.customer_id` FK references `customers.customer_id`.

---

## 10. Deploy Target

- **Platform:** `shopops-api` (Node.js, Docker on BDC server)
- **Environment:** Staging Supabase only
- **Migration apply order:**
  1. `YYYYMMDD_subscriptions.sql` (if new)
  2. `YYYYMMDD_customer_pulls.sql`
- **Runtime verify (Rule 19):**
  ```bash
  docker exec shopops-api grep -n "createPull\|transitionPull\|assertPullBillable" \
    /app/services/customerPulls.js 2>&1
  ```
  `STATUS=skipped_container_not_rebuilt` acceptable with RULE19_RERUN in manifest.
- **No production deploy** without John's "PROCEED DEPLOY."

---

## 11. Test Scenarios

Tests: `shopops-api/tests/customerPulls.test.js`. All run against staging Supabase (Rule 16).

**Test 1 — Create pull (happy path)**

Given: valid `tenant_id`, `customer_id` (existing in `customers`), `issue_id`, `quantity_requested=2`,
  `foc_date='2026-06-15'`, `request_source='POS'`
When: `createPull(tenantId, payload)` is called
Then:
- Returns a `pull_id` (UUID)
- `SELECT status FROM customer_pulls WHERE pull_id=$1` returns `'REQUESTED'`
- `quantity_allocated` is `0`

**Test 2 — Legal transition: REQUESTED -> FOC_LOCKED**

Given: pull in status `REQUESTED`
When: `transitionPull(tenantId, pullId, 'FOC_LOCKED')` is called
Then:
- Returns updated pull with `status = 'FOC_LOCKED'`
- `SELECT status FROM customer_pulls WHERE pull_id=$1` = `'FOC_LOCKED'`

**Test 3 — Illegal transition rejected**

Given: pull in status `INVOICED`
When: `transitionPull(tenantId, pullId, 'REQUESTED')` is called
Then:
- Throws `IllegalStateTransition` (or equivalent named error)
- `SELECT status FROM customer_pulls WHERE pull_id=$1` still = `'INVOICED'` (no mutation)

**Test 4 — Billing invariant enforced**

Given: pull in status `REQUESTED`
When: `assertPullBillable(pull)` is called
Then:
- Throws an error with message containing `"not billable"` or `"REQUESTED"`
- Pull status is NOT mutated

Given: pull in status `ALLOCATED`
When: `assertPullBillable(pull)` is called
Then:
- Does NOT throw — returns without error

**Test 5 — CANCELLED from REQUESTED (before FOC lock)**

Given: pull in status `REQUESTED`
When: `transitionPull(tenantId, pullId, 'CANCELLED')` is called
Then:
- `status = 'CANCELLED'` — terminal state
- Subsequent transition attempt throws `IllegalStateTransition`

**Test 6 — Subscription-linked pull**

Given: a valid `subscription_id` from `subscriptions` table
When: `createPull(tenantId, { subscription_id, customer_id, issue_id, ... })` is called
Then:
- Pull row has `subscription_id` populated
- FK constraint passes (no DB error)
- `SELECT subscription_id FROM customer_pulls WHERE pull_id=$1` = subscription_id

**Test 7 — reconcilePullAllocation blocks when insufficient inventory**

Given: FOC_LOCKED pull with `quantity_requested=10`, but `safe_available_qty=3` for that item
When: `reconcilePullAllocation(tenantId, pullId)` is called
Then:
- Throws `InsufficientInventory` (or equivalent)
- Pull status remains `FOC_LOCKED`
- `reserved_qty` on `inventory_items` is NOT incremented

**How does CI prove it works?**
```bash
cd shopops-api && bun test tests/customerPulls.test.js
```
All 7 tests must pass. CI runs on every PR.

---

## 12. Stop Point

**Stop 1 — customer_pulls table exists in staging**
```bash
psql "$SUPABASE_DB_URL" -c "SELECT COUNT(*) FROM customer_pulls;" \
  && echo "PASS: table exists" || (echo "FAIL: table missing" && exit 1)
```

**Stop 2 — Status constraint enforced**
```bash
psql "$SUPABASE_DB_URL" -c \
  "INSERT INTO customer_pulls (tenant_id, customer_id, issue_id, status, quantity_requested, request_source)
   VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'INVALID_STATUS', 1, 'MANUAL');" \
  2>&1 | grep -q "violates check constraint" \
  && echo "PASS: constraint enforced" || (echo "FAIL: invalid status accepted" && exit 1)
```

**Stop 3 — Billing invariant test in code**
```bash
grep -r "assertPullBillable" shopops-api/services/customerPulls.js | grep -q "." \
  && echo "PASS" || (echo "FAIL: assertPullBillable missing" && exit 1)
grep -r "REQUESTED" shopops-api/services/customerPulls.js | grep -q "assertPullBillable\|not billable\|billable" \
  && echo "PASS" || (echo "WARN: check assertPullBillable guards REQUESTED state" && exit 1)
```

**Stop 4 — All unit tests pass**
```bash
cd shopops-api && bun test tests/customerPulls.test.js
# Exit code 0, output contains "7 pass"
```

**Stop 5 — Grep assertions pass (all 6 from §8)**
```bash
grep -q "createPull" shopops-api/services/customerPulls.js && echo "PASS createPull"
grep -q "transitionPull" shopops-api/services/customerPulls.js && echo "PASS transitionPull"
grep -q "assertPullBillable" shopops-api/services/customerPulls.js && echo "PASS assertPullBillable"
grep -qi "IllegalStateTransition\|illegal.*state" shopops-api/services/customerPulls.js && echo "PASS transition guard"
grep -q "customer_pulls" shopops-api/db/migrations/*.sql && echo "PASS migration"
grep -q "REQUESTED" shopops-api/services/customerPulls.js && echo "PASS status constants"
```

**Stop 6 — Dependency check: customers table exists**
```bash
psql "$SUPABASE_DB_URL" -c "SELECT COUNT(*) FROM customers;" \
  && echo "PASS: customers table present" || (echo "FAIL: dependency missing" && exit 1)
```

**Stop 7 — Rule 19 runtime verify**
```bash
docker exec shopops-api grep -n "createPull\|transitionPull" \
  /app/services/customerPulls.js 2>&1 \
  && echo "STATUS=ok" || echo "STATUS=skipped_container_not_rebuilt"
```

**Stop 8 — PR opened against shopops-api/main**

Given: stops 1–7 pass
When: `gh pr view --repo bluedevilcollectibles/shopops-api --json state,title` is run
Then: `state=OPEN`, title contains `WO-SHOPOPS-PULL-LIST-CUSTOMER-PULL-MODEL-01`, body contains `Closes #115`

All 8 stops must appear in the Captain CI manifest under VALIDATION: PASS.
