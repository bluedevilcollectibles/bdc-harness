# WO-SHOPOPS-PULL-LIST-FULFILLMENT-HANDOFF-01

**WO ID:** WO-SHOPOPS-PULL-LIST-FULFILLMENT-HANDOFF-01
**Priority:** P0
**Builder:** Codex
**Repo:** shopops-api
**GitHub Issue:** #120
**Status:** To Do
**Class:** CODE
**References:** wo-recipe.md, docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md

---

## 1. Objective

Wire the pull-list fulfillment lifecycle in Shop Ops. Pull-list fulfillment rows must reference `allocation_id` where applicable. Channel order fulfillment must reference a canonical Shop Ops order and customer identity. Fulfillment state must be visible in the Management UI via the existing fulfillment dashboard endpoint. All nine source channels must be handled: PULL_LIST, STOREFRONT, POS, WHATNOT, SHOPIFY, EBAY, WOOCOMMERCE, TIKTOK, MANUAL.

**What behavior exists AFTER this WO?**
After this WO:
1. `createFulfillmentRow` validates that PULL_LIST source rows carry an `allocation_id`.
2. All non-PULL_LIST channel rows carry a `shopops_order_id` and `shopops_customer_id`.
3. `GET /fulfillment/runs` returns fulfillment state visible in the Management UI.
4. Fulfillment rows without required references are rejected at the API boundary (HTTP 422).

**Who owns this system?**
Shop Ops API team (Builder: Codex). John Ranson is release authority.

---

## 2. Behavior Source of Truth

Primary: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 5.7 — Fulfillment.

Canonical fulfillment rules from §5.7:
- Sources: PULL_LIST, STOREFRONT, POS, WHATNOT, SHOPIFY, EBAY, WOOCOMMERCE, TIKTOK, MANUAL.
- Pull-list fulfillment rows must reference allocation where applicable.
- Channel order fulfillment must reference canonical order and customer identity.
- Fulfillment state must be visible in Management UI.

**Where is the source of truth?**
The `fulfillment_rows` table is the canonical record of fulfillment. The `allocations` table is the upstream anchor for pull-list rows. The architecture doc cited above is the authoritative specification.

**What existing logic is reused?**
- Allocation lookup helpers from `db/allocations.js` (added by WO-SHOPOPS-PULL-LIST-ALLOCATION-ENGINE-01).
- Customer identity binding from `db/customers.js` (added by WO-SHOPOPS-CUSTOMER-IDENTITY-BINDING-01).
- Existing order lookup from `db/orders.js` (EXISTING — to be confirmed at file read time).
- Management UI fulfillment dashboard route pattern from `routes/management.js`.

---

## 3. Prior Art Check

Reviewed: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Sections 4, 5.7.

Existing patterns to reuse:
- `services/billing.js` — allocation status validation pattern (reuse `validateBillingAllocation` guard logic).
- `db/allocations.js` — `getAllocationById` (added by dependency WO).
- `db/customers.js` — customer identity resolution (added by dependency WO).
- `routes/management.js` — existing Management UI route file; add `GET /fulfillment/runs` here.
- Channel enum validation pattern from existing order intake code.

---

## 4. System Context

**Repository:** `shopops-api` (Node.js, ES modules, deployed as Docker container `shopops-api`)

**Dependencies (must be deployed before this WO):**
- `WO-SHOPOPS-PULL-LIST-ALLOCATION-ENGINE-01` — `allocations` table, `getAllocationById`, allocation lifecycle state machine.
- `WO-SHOPOPS-CUSTOMER-IDENTITY-BINDING-01` — `customers` table, customer identity resolution.

**Runtime environment:**
- Docker container: `shopops-api`
- Source path inside container: `/app/`
- No source mount — image must be rebuilt and restarted for changes to take effect (Rule 19).

**Affected services:**
- `services/fulfillment.js` — fulfillment row creation and lifecycle (NEW).
- `db/fulfillment.js` — fulfillment DB helpers (NEW).
- `routes/fulfillment.js` — API routes (`POST /fulfillment/rows`, `GET /fulfillment/runs`) (NEW).
- `routes/management.js` — Management UI endpoint extension (EXISTING — add fulfillment visibility).
- `db/allocations.js` — `getAllocationById` (EXISTING from dependency WO).

---

## 5. UI Hierarchy

Per `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`:

Management UI fulfillment visibility is exposed via `GET /fulfillment/runs`. The response includes:
- `source` (channel enum)
- `status` (PENDING, IN_PROGRESS, FULFILLED, CANCELLED)
- `allocation_id` (nullable — present for PULL_LIST rows)
- `shopops_order_id` (nullable — present for channel rows)
- `shopops_customer_id`
- `fulfilled_at`

No new frontend components are introduced by this WO. The existing Management UI fulfillment dashboard consumes this endpoint (frontend work is out of scope; endpoint must conform to existing API contract expected by the dashboard).

---

## 6. Mode Behavior Matrix

| Source | allocation_id required? | shopops_order_id required? | shopops_customer_id required? |
|---|---|---|---|
| PULL_LIST | YES | No | YES |
| STOREFRONT | No | YES | YES |
| POS | No | YES | YES |
| WHATNOT | No | YES | YES |
| SHOPIFY | No | YES | YES |
| EBAY | No | YES | YES |
| WOOCOMMERCE | No | YES | YES |
| TIKTOK | No | YES | YES |
| MANUAL | No | No | YES (best-effort) |

**Rejection rules:**
- PULL_LIST row without `allocation_id` → HTTP 422, `FULFILLMENT_MISSING_ALLOCATION`.
- Non-MANUAL channel row without `shopops_order_id` → HTTP 422, `FULFILLMENT_MISSING_ORDER`.
- Any row without `shopops_customer_id` (except MANUAL) → HTTP 422, `FULFILLMENT_MISSING_CUSTOMER`.

**What MUST NEVER break? (invariants)**
- PULL_LIST fulfillment rows must always carry `allocation_id`.
- Channel fulfillment rows must always carry `shopops_order_id` (except MANUAL).
- `fulfilled_at` on the allocation row must be stamped when PULL_LIST row status reaches FULFILLED.
- Idempotent creates: same `(allocation_id, source)` pair cannot produce two PENDING rows.

**What happens if it runs twice? (idempotency)**
`createFulfillmentRow` checks for an existing non-CANCELLED row with the same `(allocation_id, source)` or `(shopops_order_id, source)` before inserting. If found, the existing row is returned (HTTP 200). No duplicate rows are created.

---

## 7. Backend Function Inventory

| Function | File | Status |
|---|---|---|
| `createFulfillmentRow(params)` | `services/fulfillment.js` | NEW |
| `updateFulfillmentStatus(fulfillmentRowId, status)` | `services/fulfillment.js` | NEW |
| `validateFulfillmentSource(source, params)` | `services/fulfillment.js` | NEW |
| `getFulfillmentRuns(tenantId, filters)` | `services/fulfillment.js` | NEW |
| `upsertFulfillmentRow(params)` | `db/fulfillment.js` | NEW |
| `getFulfillmentRowById(fulfillmentRowId)` | `db/fulfillment.js` | NEW |
| `getFulfillmentRowsByAllocation(allocationId)` | `db/fulfillment.js` | NEW |
| `listFulfillmentRuns(tenantId, filters)` | `db/fulfillment.js` | NEW |
| `POST /fulfillment/rows` route handler | `routes/fulfillment.js` | NEW |
| `GET /fulfillment/runs` route handler | `routes/fulfillment.js` | NEW |
| `getAllocationById(allocationId)` | `db/allocations.js` | EXISTING (added by WO-SHOPOPS-PULL-LIST-ALLOCATION-ENGINE-01) |

---

## 8. Data Flow

```
[API caller] → POST /fulfillment/rows
    → validateFulfillmentSource(source, params)
        → PULL_LIST + no allocation_id → throw FULFILLMENT_MISSING_ALLOCATION (422)
        → non-MANUAL + no shopops_order_id → throw FULFILLMENT_MISSING_ORDER (422)
        → non-MANUAL + no shopops_customer_id → throw FULFILLMENT_MISSING_CUSTOMER (422)
    → createFulfillmentRow(params)
        → if PULL_LIST: getAllocationById(allocation_id) — verify allocation exists + correct tenant
        → upsertFulfillmentRow (idempotency check)
        → if creating new row: stamp allocation.fulfilled_at when status = FULFILLED
        → return fulfillment_row

[Management UI] → GET /fulfillment/runs?tenantId=X
    → getFulfillmentRuns(tenantId, filters)
        → listFulfillmentRuns(tenantId, filters)
        → return array of { source, status, allocation_id, shopops_order_id, shopops_customer_id, fulfilled_at }
```

**Grep assertions (Check 8A):**
The following strings MUST appear in the deployed source after this WO:

```bash
grep -rn "createFulfillmentRow" /app/services/fulfillment.js
grep -rn "FULFILLMENT_MISSING_ALLOCATION" /app/services/fulfillment.js
grep -rn "FULFILLMENT_MISSING_ORDER" /app/services/fulfillment.js
grep -rn "validateFulfillmentSource" /app/services/fulfillment.js
grep -rn "PULL_LIST\|STOREFRONT\|WHATNOT\|SHOPIFY\|EBAY\|WOOCOMMERCE\|TIKTOK" /app/services/fulfillment.js
grep -rn "GET.*fulfillment/runs" /app/routes/fulfillment.js
grep -rn "POST.*fulfillment/rows" /app/routes/fulfillment.js
```

**How does CI prove it works?**
The test suite (`tests/test_fulfillment_handoff.js`) runs against staging Supabase with real allocation and customer fixtures. Tests assert required field validation, idempotency, and correct stamping of `allocation.fulfilled_at`.

---

## 9. Database Schema References

**`allocations` table** — dependency from WO-SHOPOPS-PULL-LIST-ALLOCATION-ENGINE-01, migration `migrations/004_allocations.sql`.
Key columns used here: `allocation_id`, `tenant_id`, `status`, `fulfilled_at`.

Schema verification: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'allocations' AND table_schema = 'public' ORDER BY ordinal_position;`

**`fulfillment_rows` table** — NEW, created by migration `migrations/008_fulfillment_rows.sql`:

| Column | Type | Notes |
|---|---|---|
| `tenant_id` | UUID | |
| `fulfillment_row_id` | UUID PK | |
| `source` | TEXT | PULL_LIST, STOREFRONT, POS, WHATNOT, SHOPIFY, EBAY, WOOCOMMERCE, TIKTOK, MANUAL |
| `status` | TEXT | PENDING, IN_PROGRESS, FULFILLED, CANCELLED |
| `allocation_id` | UUID | nullable FK to allocations (required for PULL_LIST) |
| `shopops_order_id` | UUID | nullable FK to orders (required for non-MANUAL channels) |
| `shopops_customer_id` | UUID | FK to customers, NOT NULL except MANUAL |
| `fulfilled_at` | TIMESTAMPTZ | nullable |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

Unique constraint: `(tenant_id, allocation_id, source)` WHERE `allocation_id IS NOT NULL` AND `status != 'CANCELLED'`.
Unique constraint: `(tenant_id, shopops_order_id, source)` WHERE `shopops_order_id IS NOT NULL` AND `status != 'CANCELLED'`.

Schema claim: all column names and types above are defined in `migrations/008_fulfillment_rows.sql` (created by this WO). Verify after migration: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'fulfillment_rows' AND table_schema = 'public' ORDER BY ordinal_position;`

---

## 10. Deploy Target

- **Repo:** `bluedevilcollectibles/shopops-api`
- **Branch:** `wo/shopops-pull-list-fulfillment-handoff-01`
- **Base branch:** `main`
- **PR:** Closes #120
- **Runtime:** Docker container `shopops-api` — requires image rebuild + restart after merge.
- **Migrations:** `migrations/008_fulfillment_rows.sql` — run against staging Supabase before production deploy.
- **Rule 19:** After container rebuild: `docker exec shopops-api grep -n "createFulfillmentRow" /app/services/fulfillment.js` must return at least one match.

---

## 11. Test Scenarios

**Test 1 — PULL_LIST row with valid allocation accepted**
- Given: An allocation exists with `allocation_id = X`, status = `READY_TO_INVOICE`, belonging to tenant T.
- When: `POST /fulfillment/rows` is called with `{ source: "PULL_LIST", allocation_id: X, shopops_customer_id: C }`.
- Then: HTTP 201 is returned, a `fulfillment_rows` row is inserted with `source = PULL_LIST` and `allocation_id = X`. `fulfilled_at` on the allocation is null (row is still PENDING).

**Test 2 — PULL_LIST row without allocation_id rejected**
- Given: Any request state.
- When: `POST /fulfillment/rows` is called with `{ source: "PULL_LIST", shopops_customer_id: C }` (no `allocation_id`).
- Then: HTTP 422 is returned with `{ "error": "FULFILLMENT_MISSING_ALLOCATION" }`. No row is inserted.

**Test 3 — SHOPIFY row without shopops_order_id rejected**
- Given: Any request state.
- When: `POST /fulfillment/rows` is called with `{ source: "SHOPIFY", shopops_customer_id: C }` (no `shopops_order_id`).
- Then: HTTP 422 is returned with `{ "error": "FULFILLMENT_MISSING_ORDER" }`. No row is inserted.

**Test 4 — Management UI visibility**
- Given: Three fulfillment rows exist for tenant T across sources PULL_LIST, SHOPIFY, and POS.
- When: `GET /fulfillment/runs?tenantId=T` is called.
- Then: HTTP 200 is returned with an array of 3 objects. Each object includes `source`, `status`, `fulfilled_at`. The PULL_LIST row includes a non-null `allocation_id`. The SHOPIFY and POS rows include non-null `shopops_order_id`.

**Test 5 — Idempotency**
- Given: A PULL_LIST fulfillment row already exists for `(allocation_id = X, source = PULL_LIST)` with status PENDING.
- When: `POST /fulfillment/rows` is called again with the same parameters.
- Then: HTTP 200 is returned with the existing row. Row count for `(allocation_id = X, source = PULL_LIST)` remains 1.

**Test 6 — allocation.fulfilled_at stamped on FULFILLED transition**
- Given: A PULL_LIST fulfillment row exists in PENDING status for `allocation_id = X`.
- When: `updateFulfillmentStatus(fulfillmentRowId, "FULFILLED")` is called.
- Then: `fulfillment_rows.status` = FULFILLED, `fulfillment_rows.fulfilled_at` is set, and `allocations.fulfilled_at` is also stamped with the same timestamp.

---

## 12. Stop Point

All of the following must pass before marking REVIEW:

```bash
# 1. Grep assertions pass
grep -rn "createFulfillmentRow" shopops-api/services/fulfillment.js
grep -rn "FULFILLMENT_MISSING_ALLOCATION" shopops-api/services/fulfillment.js
grep -rn "validateFulfillmentSource" shopops-api/services/fulfillment.js
grep -rn "PULL_LIST" shopops-api/services/fulfillment.js

# 2. Test suite passes
cd shopops-api && bun test tests/test_fulfillment_handoff.js
# Expected: >= 6 tests, 0 failures

# 3. Migration file exists
ls shopops-api/migrations/008_fulfillment_rows.sql

# 4. Rule 19 runtime verification (after container rebuild)
docker exec shopops-api grep -n "createFulfillmentRow" /app/services/fulfillment.js
# Expected: at least one matching line

# 5. PR opened
gh pr view --repo bluedevilcollectibles/shopops-api
# Expected: PR exists targeting main, "Closes #120" in body
```

**Given/When/Then CI gate:**
- Given: All grep assertions return matches and migration file exists.
- When: `bun test tests/test_fulfillment_handoff.js` runs against staging Supabase.
- Then: All tests pass (0 failures), PR is open against main with Closes #120, and Rule 19 docker exec confirms source deployed.
