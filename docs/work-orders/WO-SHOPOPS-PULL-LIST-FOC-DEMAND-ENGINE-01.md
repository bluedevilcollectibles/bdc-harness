# WO-SHOPOPS-PULL-LIST-FOC-DEMAND-ENGINE-01
<!-- wo-recipe.md 12-section template — see ~/.claude/reference/wo-recipe.md -->

**WO ID:** WO-SHOPOPS-PULL-LIST-FOC-DEMAND-ENGINE-01
**Priority:** P1
**Builder:** Codex
**Repo:** shopops-api (subdirectory of bluedevilcollectibles/shopops)
**GH Issue:** #116
**Status:** To Do
**Class:** CODE

---

## 1. Objective

Build the FOC (Final Order Count) demand aggregation engine for Shop Ops HQ.

The engine loads upcoming solicitations with their FOC date, finds all active customer pulls for each issue, groups demand by issue/distributor/date, adds staff-configured shelf copy and buffer quantity, and produces a canonical order demand record. A distributor export (CSV) is generated from this canonical demand.

After this WO the following is true:
- `POST /foc/aggregate` computes canonical pull demand per solicitation and upserts `foc_orders` rows with `pull_count`, `buffer_qty`, and `order_qty`.
- `GET /foc/upcoming` returns solicitations with their aggregated demand within a configurable lookahead window.
- `POST /foc/:foc_date/confirm` lets staff adjust `buffer_qty` and confirm order quantities, locking the FOC.
- `POST /foc/:foc_date/export` generates a distributor-ready CSV and persists a `distributor_orders` record.
- Shopify/storefront/POS may display FOC-related info but MUST NOT compute canonical demand. All demand computation is server-side in Shop Ops HQ.

---

## 2. Behavior Source of Truth

Primary: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 5.2

The spec defines:
1. Shop Ops HQ loads upcoming solicitations with FOC date.
2. Engine finds all active pulls for each issue.
3. Engine groups demand by issue/distributor/date.
4. Staff may add shelf copy / buffer quantity.
5. Engine produces order demand: customer pull quantity + shelf/buffer quantity = total order quantity.
6. Distributor export is generated from canonical demand.

Rule (from spec §5.2): FOC demand is not a channel concern. Shopify/storefront/POS may show FOC-related info but MUST NOT compute canonical demand.

Secondary (existing codebase behavior, verified 2026-05-16):
- `shopops-api/routes/foc.js` — current implementation covering GET /foc/upcoming, POST /foc/aggregate, POST /foc/:foc_date/confirm, POST /foc/:foc_date/export.
- `shopops-api/migrations/20260512_foc_notifications.sql` — FOC notification schema.
- `shopops-api/services/foc-locking.js` — FOC lock transition service.

---

## 3. Prior Art Check

Reference architecture spec: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 5.2

Existing implementation verified by reading `shopops-api/routes/foc.js`:
- GET /foc/upcoming (line 33): aggregates pull counts from `customer_pulls` joined to `solicitations`. Returns `foc_items` array. Lazy-inits `foc_orders` rows.
- POST /foc/aggregate (line 129): idempotent upsert of `foc_orders` rows from `customer_pulls`. Uses `ON CONFLICT (tenant_id, solicitation_id) DO UPDATE`.
- POST /foc/:foc_date/confirm (line 199): lets staff set `buffer_qty`; updates `order_qty = pull_count + buffer_qty`. Locks FOC via `foc-locking.js`.
- POST /foc/:foc_date/export (line 288): generates CSV from confirmed `foc_orders`; inserts `distributor_orders` record; transitions eligible `customer_pulls` to FOC_LOCKED.

Gap vs. spec (what this WO adds):
- The engine only joins `customer_pulls` on `solicitation_id`. The spec requires grouping by **distributor** and **date** in addition to issue. A `distributor` dimension must be threaded through the aggregate and export.
- `foc_orders` currently tracks `buffer_qty` as a single field. The spec requires staff to be able to set shelf copy quantity separately from buffer. This WO adds a `shelf_qty` column.
- The export route does not yet return a demand breakdown (pull qty / shelf qty / total) in the JSON response. This WO adds that breakdown.

---

## 4. System Context

**Dependencies (MUST exist before this WO executes):**
- `WO-SHOPOPS-PULL-LIST-CUSTOMER-PULL-MODEL-01` — `customer_pulls` table must exist with columns: `tenant_id`, `pull_id` (alias for `id`), `customer_id`, `issue_id`, `solicitation_id`, `subscription_id`, `quantity`, `status`, `foc_date`, `request_source`, `created_at`, `deleted_at`.
- `solicitations` table — must exist with `id`, `foc_date`, `status`, `distributor`, `series_name`, `issue_number`, `lunar_code`, `upc`, `price_cents`.
- `foc_orders` table — must exist with `id`, `tenant_id`, `solicitation_id`, `foc_date`, `pull_count`, `buffer_qty`, `order_qty`, `status`, `confirmed_at`, `version`.
- `distributor_orders` table — must exist with `id`, `tenant_id`, `distributor`, `foc_date`, `order_data` (JSONB), `total_units`, `total_cost_cents`, `status`, `created_at`.

**Downstream consumers:**
- `POST /foc/:foc_date/export` CSV — sent to distributor (Diamond, PRH) for order fulfillment.
- `WO-SHOPOPS-PULL-LIST-INVENTORY-RECEIPT-01` — receipt path matches received items to `distributor_orders` and `foc_orders`.
- `WO-SHOPOPS-PULL-LIST-ALLOCATION-ENGINE-01` — allocation engine reads confirmed `foc_orders` to bound allocation quantities.

**Who owns this system:** Shop Ops HQ / Major Build. John Ranson is release authority.

---

## 5. UI Hierarchy

Per `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`:

```
Shop Ops HQ (canonical authority)
  └── FOC Demand Engine (this WO)
        ├── GET  /foc/upcoming          -- staff views upcoming FOC deadlines
        ├── POST /foc/aggregate         -- staff or cron triggers demand recompute
        ├── GET  /foc/:foc_date         -- staff views per-date foc_orders detail
        ├── POST /foc/:foc_date/confirm -- staff adjusts shelf_qty + buffer_qty, confirms
        └── POST /foc/:foc_date/export  -- staff exports distributor CSV

Shopify / POS / Storefront
  └── MAY display FOC info from /foc/upcoming READ-ONLY
  └── MUST NOT compute demand
```

Staff-facing UI reads from these routes; no new UI routes are added by this WO (frontend is out of scope here).

---

## 6. Mode Behavior Matrix

| Operation | Input | Result | Idempotent? |
|---|---|---|---|
| POST /foc/aggregate | tenant_id (header) | Upserts foc_orders rows for all active solicitations with future FOC date | YES — ON CONFLICT DO UPDATE |
| GET /foc/upcoming?days=N | days param (1-60) | Returns solicitation list with pull_count, shelf_qty, buffer_qty, order_qty | YES — read-only |
| GET /foc/:foc_date | foc_date path param | Returns all foc_orders for that date | YES — read-only |
| POST /foc/:foc_date/confirm | { idempotency_key, adjustments?: [{foc_order_id, shelf_qty, buffer_qty, order_qty}] } | Updates buffer/shelf/order qty; sets status='confirmed'; locks via foc-locking.js | YES — idempotency_key |
| POST /foc/:foc_date/export | { idempotency_key } | Generates CSV; inserts distributor_orders row; transitions customer_pulls to FOC_LOCKED | YES — idempotency_key |
| Run aggregate twice | Same tenant | Second call produces same foc_orders rows (no duplicates) | YES |
| Export same date twice | Same idempotency_key | Second call returns existing distributor_orders row (no duplicate) | YES |

---

## 7. Backend Function Inventory

All functions labeled NEW or EXISTING (file:line) per wo-recipe.md.

| Function | Status | Notes |
|---|---|---|
| `GET /foc/upcoming` route | EXISTING (foc.js:33) | Extend: add `shelf_qty` to SELECT, add distributor grouping |
| `POST /foc/aggregate` route | EXISTING (foc.js:129) | Extend: add `shelf_qty` to upsert; add distributor column to GROUP BY |
| `GET /foc/:foc_date` route | EXISTING (foc.js:87) | Extend: include `shelf_qty` in response |
| `POST /foc/:foc_date/confirm` route | EXISTING (foc.js:199) | Extend: accept `shelf_qty` in adjustment body; update `order_qty = pull_count + shelf_qty + buffer_qty` |
| `POST /foc/:foc_date/export` route | EXISTING (foc.js:288) | Extend: include demand breakdown (pull_qty, shelf_qty, buffer_qty, order_qty) per row in order_data JSONB |
| `computeFocDemandByDistributor(client, tenantId, focDate)` | NEW | Pure query function: returns rows grouped by {solicitation_id, distributor, foc_date, pull_count}. Used by aggregate + export. |
| `buildDistributorCsv(rows)` | NEW (extract from foc.js:288 inline) | Extract CSV-building logic from export route into named function; adds shelf_qty and buffer_qty columns |
| `foc-locking.js:lockPullsForFocDate(client, tenantId, focDate)` | EXISTING (foc-locking.js) | No change |

Migration:
| Migration | Status | Notes |
|---|---|---|
| `20260517_foc_orders_shelf_qty.sql` | NEW | ALTER TABLE foc_orders ADD COLUMN shelf_qty INTEGER NOT NULL DEFAULT 0; UPDATE order_qty formula to include shelf_qty |

---

## 8. Data Flow

```
staff/cron
  |
  v
POST /foc/aggregate
  |--[1]--> SELECT solicitations WHERE foc_date >= today AND status = 'active'
  |--[2]--> LEFT JOIN customer_pulls ON solicitation_id WHERE cp.status NOT IN ('CANCELLED','PICKED_UP','FULFILLED') AND cp.deleted_at IS NULL
  |--[3]--> GROUP BY solicitation_id, s.distributor, s.foc_date  --> pull_count per group
  |--[4]--> UPSERT foc_orders (pull_count, order_qty = pull_count + shelf_qty + buffer_qty)
  |
  v
staff reviews GET /foc/upcoming or GET /foc/:foc_date
  |
  v
POST /foc/:foc_date/confirm  (staff sets shelf_qty, buffer_qty)
  |--[5]--> UPDATE foc_orders SET shelf_qty, buffer_qty, order_qty = pull_count + shelf_qty + buffer_qty, status = 'confirmed'
  |--[6]--> foc-locking.js: lock customer_pulls to FOC_LOCKED
  |
  v
POST /foc/:foc_date/export
  |--[7]--> SELECT confirmed foc_orders WHERE order_qty > 0
  |--[8]--> computeFocDemandByDistributor --> build CSV per distributor
  |--[9]--> INSERT distributor_orders (order_data JSONB includes demand breakdown)
  |--[10]--> respond with { ok, csv, distributor_order_id, demand_summary }
```

**What MUST NEVER break (invariants):**
- `order_qty` = `pull_count + shelf_qty + buffer_qty` at all times. If `shelf_qty` or `buffer_qty` is NULL, treat as 0.
- `order_qty >= pull_count` always (staff cannot set order qty below pull count).
- `distributor_orders` rows are never deleted by this engine (read-append pattern).
- `customer_pulls` status transitions (to FOC_LOCKED) are made only during export, not during aggregate.
- FOC demand is computed server-side only. No channel or storefront may write to `foc_orders`.

**Idempotency:** Running aggregate twice for the same date produces identical `foc_orders` state. Running export twice with the same `idempotency_key` returns the existing `distributor_orders` row without re-inserting.

---

## 9. Database Schema References

All column claims verified against the live codebase (foc.js, shipments.js, inventory.js reads, migrations directory — 2026-05-16).

**`foc_orders`** (verified via grep of foc.js:100 and migration 20260512_foc_notifications.sql):
```sql
-- Verified columns from reading foc.js:100 SELECT statement:
SELECT column_name FROM information_schema.columns
WHERE table_name = 'foc_orders' ORDER BY ordinal_position;
-- Expected: id, tenant_id, solicitation_id, foc_date, pull_count, buffer_qty,
--           order_qty, status, confirmed_at, version, created_at, updated_at
-- NEW via this WO migration 20260517_foc_orders_shelf_qty.sql:
ALTER TABLE foc_orders ADD COLUMN IF NOT EXISTS shelf_qty INTEGER NOT NULL DEFAULT 0;
```

**`customer_pulls`** (verified via migration 20260507_pull_list_state_machine.sql):
```sql
-- Status enum (CHECK constraint customer_pulls_status_check, verified via migration):
-- 'ANNOUNCED','CONFIRMED','FOC_LOCKED','READY','ALLOCATED','PAID','PICKED_UP',
-- 'FULFILLED','MATCHED','ORDERED','CANCELLED','VOID'
-- Active pulls exclude: CANCELLED, PICKED_UP, FULFILLED
```

**`solicitations`** (verified via foc.js:49-51 SELECT columns):
```sql
-- Columns referenced: id, title, series_name, issue_number, variant_desc,
--   foc_date, release_date, lunar_code, upc, is_variant, ratio, price_cents,
--   status ('active' filter), distributor (NEW: must exist or be added)
```

**`distributor_orders`** (verified via foc.js:365 INSERT statement):
```sql
-- INSERT columns: tenant_id, distributor, foc_date, order_data, total_units, total_cost_cents
-- order_data is JSONB; this WO extends schema to include demand_breakdown per row
```

---

## 10. Deploy Target

- Repo: `bluedevilcollectibles/shopops`
- Subdirectory: `shopops-api/`
- Branch: `wo/shopops-pull-list-foc-demand-engine-01`
- PR base: `master` (shopops default branch is master, NOT main)
- Migration applied via SSH to Hetzner prod Supabase (after PR merge + John's PROCEED DEPLOY)
- Rule 19: `docker exec shopops-api grep -n 'computeFocDemandByDistributor' /app/routes/foc.js`

---

## 11. Test Scenarios

All tests in `shopops-api/tests/test_foc_demand_engine.js`. Run with `cd shopops-api && bun tests/test_foc_demand_engine.js`.

**Scenario 1: Aggregate computes correct pull_count grouped by distributor**

Given: Two solicitations with the same FOC date; solicitation A belongs to distributor 'lunar', solicitation B to distributor 'prh'. Three active customer_pulls on solicitation A (quantities 1, 2, 1). One active customer_pull on solicitation B (quantity 3). One CANCELLED pull on solicitation A (quantity 5, must be excluded).

When: `POST /foc/aggregate` is called with tenant_id = test_tenant.

Then:
- HTTP 200 with `{ ok: true, upserted: 2 }`.
- `foc_orders` row for solicitation A has `pull_count = 4` (not 9 — cancelled pull excluded).
- `foc_orders` row for solicitation B has `pull_count = 3`.
- Each row's `distributor` field matches the solicitation's distributor.
- `order_qty = pull_count + shelf_qty + buffer_qty` (shelf_qty and buffer_qty default to 0, so order_qty = pull_count initially).

**Scenario 2: Confirm route sets shelf_qty and recomputes order_qty**

Given: A confirmed solicitation with `pull_count = 5`, `shelf_qty = 0`, `buffer_qty = 0`, `order_qty = 5`.

When: `POST /foc/:foc_date/confirm` is called with body `{ idempotency_key: "test-confirm-1", adjustments: [{ foc_order_id: <id>, shelf_qty: 3, buffer_qty: 2, order_qty: 10 }] }`.

Then:
- HTTP 200 with updated row.
- `foc_orders` row has `shelf_qty = 3`, `buffer_qty = 2`, `order_qty = 10`.
- `order_qty >= pull_count` (invariant holds: 10 >= 5).
- `status = 'confirmed'`.

**Scenario 3: Export produces CSV with demand breakdown and inserts distributor_orders**

Given: A confirmed `foc_orders` row for solicitation with lunar_code 'OCT241234', title 'Amazing Spider-Man #1', price_cents 499, order_qty 7, pull_count 5, shelf_qty 1, buffer_qty 1.

When: `POST /foc/:foc_date/export` is called with `{ idempotency_key: "test-export-1" }`.

Then:
- HTTP 200 with `{ ok: true, csv: "...", distributor_order_id: "<uuid>", demand_summary: { total_units: 7, total_cost_cents: 3493 } }`.
- CSV line contains: `OCT241234,Amazing Spider-Man #1,...,7,...`.
- `distributor_orders` row inserted with `total_units = 7`, `total_cost_cents = 3493`.
- `order_data` JSONB includes `demand_breakdown: [{ pull_qty: 5, shelf_qty: 1, buffer_qty: 1, order_qty: 7 }]`.
- Calling export again with same `idempotency_key` returns HTTP 200 with same `distributor_order_id` (no duplicate row).

**Scenario 4: Aggregate is idempotent — running twice produces same foc_orders state**

Given: One solicitation with two active customer_pulls (quantities 3, 4).

When: `POST /foc/aggregate` is called twice in sequence.

Then:
- Both calls return HTTP 200.
- After second call, exactly one `foc_orders` row exists for the solicitation (no duplicate).
- `pull_count = 7` in both calls.

**Scenario 5: Aggregate excludes DELETED and terminal-status pulls**

Given: Solicitation with pulls: one active CONFIRMED (qty 2), one deleted (deleted_at IS NOT NULL, qty 10), one FULFILLED (qty 5, excluded), one CANCELLED (qty 3, excluded).

When: `POST /foc/aggregate` called.

Then: `foc_orders.pull_count = 2` — only the active CONFIRMED pull is included.

---

## 12. Stop Point

All stop conditions are CI-executable commands or Given/When/Then.

**Stop 1:** Migration applied — `shelf_qty` column exists.
```bash
psql "$DATABASE_URL" -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='foc_orders' AND column_name='shelf_qty'"
# Expected output: shelf_qty
```

**Stop 2:** `computeFocDemandByDistributor` function defined in routes/foc.js.
```bash
grep -n "computeFocDemandByDistributor" shopops-api/routes/foc.js
# Expected: at least 1 match (function definition)
```

**Stop 3:** `buildDistributorCsv` extracted as named function.
```bash
grep -n "function buildDistributorCsv" shopops-api/routes/foc.js
# Expected: exactly 1 match
```

**Stop 4:** Export route includes demand breakdown in order_data.
```bash
grep -n "demand_breakdown\|pull_qty.*shelf_qty\|shelf_qty.*buffer_qty" shopops-api/routes/foc.js
# Expected: at least 2 matches
```

**Stop 5:** Tests pass.
```bash
cd shopops-api && bun tests/test_foc_demand_engine.js
# Expected: exit code 0, all 5 scenarios pass
```

**Stop 6 (Rule 19):** Function present inside running container.
```bash
docker exec shopops-api grep -n "computeFocDemandByDistributor" /app/routes/foc.js
# Expected: at least 1 match (requires container rebuild after PR merge)
```

**Stop 7:** Idempotency — aggregate twice, single foc_orders row.

Given: test tenant with 1 solicitation and 2 active pulls.
When: `POST /foc/aggregate` called twice with same tenant header.
Then: `SELECT COUNT(*) FROM foc_orders WHERE tenant_id='test_tenant' AND solicitation_id='<test-id>'` returns 1.

**Stop 8:** Channels cannot write to foc_orders.
```bash
grep -rn "foc_orders" shopops-api/routes/shopify.js shopops-api/routes/pos.js 2>/dev/null
# Expected: no INSERT or UPDATE statements touching foc_orders from channel routes
```

---

### Grep Assertions (Check 8A)

Cross-repo assertions (must pass before REVIEW):

```bash
# A1: Core demand function present
grep -n "computeFocDemandByDistributor" shopops-api/routes/foc.js
# Expected: >= 1 line

# A2: shelf_qty threaded through confirm route
grep -n "shelf_qty" shopops-api/routes/foc.js
# Expected: >= 4 lines (SELECT, UPDATE, response, order_qty formula)

# A3: demand breakdown in export
grep -n "demand_breakdown" shopops-api/routes/foc.js
# Expected: >= 1 line

# A4: order_qty formula correct
grep -n "pull_count.*shelf_qty.*buffer_qty\|shelf_qty.*buffer_qty.*pull_count" shopops-api/routes/foc.js
# Expected: >= 1 line (order_qty = pull_count + shelf_qty + buffer_qty)

# A5: migration file present
ls shopops-api/migrations/20260517_foc_orders_shelf_qty.sql
# Expected: file exists

# A6: migration adds shelf_qty
grep -n "shelf_qty" shopops-api/migrations/20260517_foc_orders_shelf_qty.sql
# Expected: >= 1 line (ADD COLUMN)
```

---

**8 Required Questions:**

1. **What behavior exists AFTER this WO?** FOC demand engine produces canonical order demand (pull qty + shelf qty + buffer qty = order_qty) per solicitation per distributor. Staff can adjust shelf/buffer quantities. Distributor CSV export includes demand breakdown. All demand computation is server-side; channels are read-only.

2. **Where is the source of truth?** `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 5.2. Codebase ground truth: `shopops-api/routes/foc.js`.

3. **Who owns this system?** Major Build executes. John Ranson is release authority. General approves architecture.

4. **What existing logic is reused?** `routes/foc.js` aggregate, confirm, and export routes are EXTENDED (not replaced). `services/foc-locking.js` is unchanged. Idempotency pattern (ON CONFLICT DO UPDATE, idempotency_keys table) is reused from existing code.

5. **What is the exact schema?** `foc_orders` gains `shelf_qty INTEGER NOT NULL DEFAULT 0`. `order_qty` formula changes to `pull_count + shelf_qty + buffer_qty`. All other columns unchanged. Full schema in §9.

6. **What MUST NEVER break?** `order_qty >= pull_count` always. `order_qty = pull_count + shelf_qty + buffer_qty` always. Channels cannot write to `foc_orders`. `distributor_orders` rows are never deleted by the engine. Customer pull status transitions happen only during export.

7. **How does CI prove it works?** Five test scenarios in `tests/test_foc_demand_engine.js` covering: pull_count grouping by distributor, shelf_qty confirm, export CSV + demand breakdown, aggregate idempotency, and DELETED/terminal-status pull exclusion.

8. **What happens if it runs twice?** Aggregate: `ON CONFLICT (tenant_id, solicitation_id) DO UPDATE` — second run updates pull_count in-place, no duplicate rows. Export: `idempotency_key` check returns existing `distributor_orders` row on second call.
