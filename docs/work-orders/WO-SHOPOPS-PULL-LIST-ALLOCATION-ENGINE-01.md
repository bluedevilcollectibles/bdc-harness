# WO-SHOPOPS-PULL-LIST-ALLOCATION-ENGINE-01
<!-- wo-recipe.md 12-section template — see ~/.claude/reference/wo-recipe.md -->

**WO ID:** WO-SHOPOPS-PULL-LIST-ALLOCATION-ENGINE-01
**Priority:** P0
**Builder:** Codex
**Repo:** shopops-api (subdirectory of bluedevilcollectibles/shopops)
**GH Issue:** #117
**Status:** To Do
**Class:** CODE

---

## 1. Objective

Build the pull-list allocation engine and its supporting table.

Allocation binds pull demand to received inventory. Each allocation record links a customer pull to a specific inventory item and quantity, carries a lifecycle status (RESERVED through terminal states), and is the canonical source of truth for reserved inventory and billing eligibility.

After this WO the following is true:
- A `pull_list_allocations` table exists with the full field set from the engine spec.
- The allocation engine (`services/allocationEngine.js`) implements four priority tiers: (1) subscription pulls confirmed before FOC, (2) manual/preorder pulls before FOC, (3) post-FOC/best-effort, (4) shelf/live-sale inventory after reserved copies.
- Shortage handling: Tier 1 is satisfied before Tier 2, Tier 2 before Tier 3. Shortages produce an operator-visible exception row in `allocation_exceptions`.
- The DA (demand analysis) tool may flag shortage exceptions but MUST NOT auto-reassign allocations.
- Billing derives from allocations — no route may INSERT into billing_statements for pull-list customers without going through the allocation-aware billing path.
- All allocation lifecycle transitions are audited in `allocation_lifecycle_events`.

---

## 2. Behavior Source of Truth

Primary: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Sections 4 and 5.4

From spec Section 4 (Allocation table fields):
```
tenant_id, allocation_id, pull_id, customer_id, inventory_item_id, quantity,
status, allocated_at, fulfilled_at, invoiced_at
```

From spec Section 4 (Lifecycle):
```
RESERVED -> READY_TO_INVOICE -> INVOICED -> SHIPPED -> PICKED_UP -> RELEASED -> CANCELLED
```

From spec Section 5.4 (Priority tiers):
1. Guaranteed subscription pulls before FOC
2. Manual/preorder pulls before FOC
3. Post-FOC requests / best effort
4. Shelf/live sale inventory after reserved copies

Shortage rule: Tier 1 before Tier 2 before Tier 3. Shortages produce operator-visible exception. DA may flag but not auto-reassign.

Rule: Allocation is source of truth for reserved pull-list inventory. Billing MUST derive from allocations. Changes MUST be auditable.

Secondary (existing codebase, verified 2026-05-16):
- `shopops-api/routes/allocations.js` — existing allocation route (POST/PATCH/GET) using the OLD single-status model. This WO transitions the table to the two-dimension model (fulfillment_status + settlement_status) per migration 076_allocation_two_dimension_status.sql.
- `shopops-api/migrations/075_pull_list_allocations_fix.sql` — existing allocation fix migration.
- `shopops-api/migrations/076_allocation_two_dimension_status.sql` — two-dimension status rename.
- `shopops-api/migrations/092_allocation_lifecycle_events.sql` — audit table.
- `shopops-api/migrations/20260409_add_allocation_tier_fields.sql` — adds pull_id, issue_key, tier, guarantee columns.
- `shopops-api/tests/test_allocation_engine_v2.js` — existing v2 engine tests (MUST still pass after this WO).

---

## 3. Prior Art Check

Reference architecture spec: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Sections 4 and 5.4

Existing state verified by reading migrations directory (2026-05-16):

**Table `pull_list_allocations`** (current columns, verified from migrations 075 + 076 + 20260409 + 092):
- `id` uuid PK
- `tenant_id` text NOT NULL
- `customer_id` text NOT NULL
- `inventory_id` uuid NULLABLE (made nullable by 075)
- `qty_allocated` integer NOT NULL DEFAULT 1 (added by 075)
- `pull_id` uuid (added by 20260409)
- `issue_key` text (added by 20260409)
- `tier` integer (added by 20260409)
- `guarantee` text (added by 20260409)
- `fulfillment_status` text (renamed from `status` by 076)
- `settlement_status` text (added by 076)
- unique constraint on (tenant_id, customer_id, issue_key)

**Gap vs. spec** (what this WO adds):
- Spec requires `allocation_id` as the primary identifier name (currently `id`). MUST NOT rename existing PK — use `id` as the primary key and expose `id` as `allocation_id` in API responses.
- Spec requires `fulfilled_at`, `invoiced_at` timestamps. These are NOT present in current schema. This WO adds them.
- Spec lifecycle includes `RELEASED`. Currently `fulfillment_status` check allows `RESERVED, READY_TO_INVOICE, INVOICED, SHIPPED, SHOW_PICKUP, CANCELLED`. This WO adds `RELEASED` and renames `SHOW_PICKUP` to `PICKED_UP` per spec.
- Spec Section 5.4 priority tier logic is partially implemented (tier column exists) but the allocation engine (`services/allocationEngine.js`) does not enforce the four-tier shortage cascade. This WO adds that enforcement.
- `allocation_exceptions` table does not exist. This WO creates it.

---

## 4. System Context

**Dependencies (MUST exist before this WO executes):**
- `WO-SHOPOPS-PULL-LIST-CUSTOMER-PULL-MODEL-01` — `customer_pulls` table with `pull_id` (id), `customer_id`, `issue_id`, `solicitation_id`, `subscription_id`, `quantity_requested`, `quantity_allocated`, `status`, `foc_date`, `request_source`.
- `WO-SHOPOPS-PULL-LIST-INVENTORY-RECEIPT-01` — `inventory_items` table with `on_hand_qty`, `reserved_qty`, `available_qty`, `cost`, `price`, `source`, `received_at`. This WO MUST NOT proceed until inventory_items has the receipt-path fields.
- `pull_list_allocations` table — must already exist (verified in migrations 075/076).
- `allocation_lifecycle_events` table — must already exist (verified in migration 092).
- `shopops-api/services/lifecycleEngine.js` — existing lifecycle transition service.

**Downstream consumers:**
- Billing path (`create_billing_statement_from_pulls` RPC, `migrations/088`) — reads allocations with `fulfillment_status IN ('READY_TO_INVOICE','INVOICED')`. MUST NOT break.
- `routes/allocations.js` — existing GET/POST/PATCH routes. This WO EXTENDS these routes.
- `routes/pullbox.js`, `routes/pullsheets.js` — reference `fulfillment_status`. MUST NOT break.
- `WO-SHOPOPS-PULL-LIST-INVENTORY-RECEIPT-01` — receipt engine calls allocation engine to reserve copies after receipt.

**Who owns this system:** Major Build executes. John Ranson is release authority.

---

## 5. UI Hierarchy

Per `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 5.4:

```
Shop Ops HQ (canonical authority)
  └── Allocation Engine (this WO)
        ├── POST /allocations/run         -- NEW: triggers priority-tier allocation pass for a FOC date
        ├── GET  /allocations             -- EXISTING: list allocations (extend with tier + timestamps)
        ├── POST /allocations             -- EXISTING: create single allocation (manual)
        ├── PATCH /allocations/:id        -- EXISTING: lifecycle transition
        ├── GET  /allocations/exceptions  -- NEW: list operator-visible shortage exceptions
        └── POST /allocations/:id/release -- NEW: release an allocation (RELEASED status)

Billing
  └── Reads from pull_list_allocations WHERE fulfillment_status IN ('READY_TO_INVOICE','INVOICED')
  └── MUST use create_billing_statement_from_pulls RPC (doctrine: pull-list-is-king.md)
```

---

## 6. Mode Behavior Matrix

| Operation | Input | Result | Idempotent? |
|---|---|---|---|
| POST /allocations/run | { foc_date, idempotency_key } | Runs priority-tier allocation pass; reserves inventory per tier order; creates exception rows for shortages | YES — idempotency_key |
| GET /allocations | tenant header, optional filters | Returns allocation list with fulfillment_status, settlement_status, tier, fulfilled_at, invoiced_at | YES — read-only |
| POST /allocations | { idempotency_key, pull_id, customer_id, inventory_item_id, quantity, tier } | Creates single RESERVED allocation; increments inventory reserved_qty | YES — idempotency_key |
| PATCH /allocations/:id | { status: 'READY_TO_INVOICE' | 'INVOICED' | 'SHIPPED' | 'PICKED_UP' | 'RELEASED' | 'CANCELLED' } | Transitions fulfillment_status; logs to allocation_lifecycle_events | NO — each call must be idempotent per current status check |
| POST /allocations/:id/release | { reason? } | Sets fulfillment_status = 'RELEASED'; decrements reserved_qty on inventory_items | YES — noop if already RELEASED |
| GET /allocations/exceptions | tenant header | Returns unresolved shortage exception rows | YES — read-only |
| Run allocation twice (same foc_date + idempotency_key) | Same inputs | Second call returns existing result; no duplicate allocations | YES |

**Shortage behavior:** When on_hand_qty < demand for a tier, Tier 1 is fully satisfied first, then Tier 2 gets remainder, then Tier 3 gets remainder. Each unsatisfied pull above the available quantity produces one row in `allocation_exceptions` with `exception_type = 'SHORTAGE'`, `tier`, `pull_id`, `customer_id`, `quantity_requested`, `quantity_available`.

---

## 7. Backend Function Inventory

All functions labeled NEW or EXISTING (file:line) per wo-recipe.md.

| Function | Status | Notes |
|---|---|---|
| `POST /allocations` route | EXISTING (allocations.js:36) | Extend: accept `pull_id`, `tier`; validate tier 1-4; set `allocated_at = now()` |
| `PATCH /allocations/:id` route | EXISTING (allocations.js) | Extend: add RELEASED, PICKED_UP (was SHOW_PICKUP) transitions; set `fulfilled_at` on SHIPPED/PICKED_UP, `invoiced_at` on INVOICED |
| `GET /allocations` route | EXISTING (allocations.js) | Extend: include `tier`, `fulfilled_at`, `invoiced_at`, `guarantee` in response |
| `POST /allocations/run` route | NEW | Triggers priority-tier allocation pass for a FOC date. Calls `runAllocationPass()`. |
| `GET /allocations/exceptions` route | NEW | Returns unresolved rows from `allocation_exceptions`. |
| `POST /allocations/:id/release` route | NEW | Transitions to RELEASED; decrements `reserved_qty` on `inventory_items`. |
| `services/allocationEngine.js:runAllocationPass(client, tenantId, focDate)` | NEW | Core engine: queries pulls by tier order, reserves inventory, creates exceptions for shortages. |
| `services/allocationEngine.js:reserveForPull(client, tenantId, pull, inventoryItemId, qty)` | NEW | Atomically increments inventory_items.reserved_qty; creates pull_list_allocations row; updates customer_pulls.quantity_allocated. |
| `services/allocationEngine.js:createShortageException(client, tenantId, pull, qtyRequested, qtyAvailable)` | NEW | Inserts allocation_exceptions row with exception_type='SHORTAGE'. |
| `services/lifecycleEngine.js:transition(client, allocationId, toStatus, actor)` | EXISTING (lifecycleEngine.js) | No change — called by PATCH route for lifecycle events. |

Migrations:
| Migration | Status | Notes |
|---|---|---|
| `20260517_allocation_engine_fields.sql` | NEW | ADD COLUMN fulfilled_at, invoiced_at; extend fulfillment_status CHECK to add RELEASED, rename SHOW_PICKUP -> PICKED_UP; CREATE TABLE allocation_exceptions |

---

## 8. Data Flow

```
POST /allocations/run (staff or receipt engine)
  |
  v
runAllocationPass(client, tenantId, focDate)
  |--[1]--> SELECT customer_pulls WHERE foc_date = ? AND status NOT IN (terminal)
  |           ORDER BY tier ASC, created_at ASC
  |--[2]--> For each pull in Tier 1:
  |           SELECT on_hand_qty, reserved_qty FROM inventory_items WHERE issue_id = pull.issue_id
  |           available_qty = max(0, on_hand_qty - reserved_qty)
  |           IF available_qty >= pull.quantity_requested:
  |             reserveForPull(pull, pull.quantity_requested)
  |           ELSE IF available_qty > 0:
  |             reserveForPull(pull, available_qty)   -- partial
  |             createShortageException(pull, pull.quantity_requested, available_qty)
  |           ELSE:
  |             createShortageException(pull, pull.quantity_requested, 0)
  |--[3]--> Repeat for Tier 2, Tier 3 (remaining available_qty only)
  |--[4]--> Tier 4 (shelf/live): no customer pull; remaining available_qty stays sellable
  |
  v
reserveForPull(client, tenantId, pull, inventoryItemId, qty)
  |--[A]--> UPDATE inventory_items SET reserved_qty = reserved_qty + qty WHERE id = ? AND (on_hand_qty - reserved_qty) >= qty
  |--[B]--> INSERT INTO pull_list_allocations (tenant_id, pull_id, customer_id, inventory_item_id, qty_allocated, tier, fulfillment_status='RESERVED', allocated_at=now())
  |--[C]--> UPDATE customer_pulls SET quantity_allocated = qty, status = 'ALLOCATED' WHERE id = pull.id
  |--[D]--> INSERT INTO allocation_lifecycle_events (fulfillment_status_before=NULL, fulfillment_status_after='RESERVED', trigger='allocation-run', actor='system')
```

**Invariants (MUST NEVER break):**
- `reserved_qty <= on_hand_qty` at all times. The UPDATE in step A uses a conditional WHERE clause.
- `available_qty = max(0, on_hand_qty - reserved_qty)` — derived, never stored except via computed view.
- Tier 1 is fully satisfied before Tier 2 gets any inventory.
- Billing MUST derive from allocations (doctrine: `docs/doctrine/pull-list-is-king.md`).
- All lifecycle transitions are logged to `allocation_lifecycle_events`.
- DA tool CANNOT auto-reassign allocations; it can only flag exceptions.

**Idempotency:** `POST /allocations/run` uses `idempotency_key`. The `reserveForPull` INSERT uses `ON CONFLICT DO NOTHING` on `(tenant_id, pull_id, inventory_item_id)` unique constraint. Second run for same FOC date with same idempotency_key is a no-op.

---

## 9. Database Schema References

All column claims verified against migrations directory (2026-05-16).

**`pull_list_allocations`** (verified via migrations 075, 076, 20260409, 092):
```sql
-- Verified from migration files:
SELECT column_name FROM information_schema.columns
WHERE table_name = 'pull_list_allocations' ORDER BY ordinal_position;
-- Current: id, tenant_id, customer_id, inventory_id, qty_allocated, pull_id,
--   issue_key, tier, guarantee, fulfillment_status, settlement_status

-- NEW via 20260517_allocation_engine_fields.sql:
ALTER TABLE pull_list_allocations
  ADD COLUMN IF NOT EXISTS fulfilled_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invoiced_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS allocated_at  TIMESTAMPTZ NOT NULL DEFAULT now();

-- fulfillment_status CHECK extended (verified: 076 has RESERVED,READY_TO_INVOICE,INVOICED,SHIPPED,SHOW_PICKUP,CANCELLED):
ALTER TABLE pull_list_allocations DROP CONSTRAINT IF EXISTS pull_list_allocations_fulfillment_status_check;
ALTER TABLE pull_list_allocations ADD CONSTRAINT pull_list_allocations_fulfillment_status_check
  CHECK (fulfillment_status IN ('RESERVED','READY_TO_INVOICE','INVOICED','SHIPPED','PICKED_UP','RELEASED','CANCELLED'));
```

**`allocation_exceptions`** (NEW table):
```sql
CREATE TABLE IF NOT EXISTS allocation_exceptions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          TEXT NOT NULL,
  foc_date           DATE NOT NULL,
  pull_id            UUID NOT NULL REFERENCES customer_pulls(id) ON DELETE CASCADE,
  customer_id        TEXT NOT NULL,
  inventory_item_id  UUID REFERENCES inventory_items(id),
  tier               INTEGER NOT NULL,
  exception_type     TEXT NOT NULL CHECK (exception_type IN ('SHORTAGE', 'NO_INVENTORY', 'PARTIAL')),
  quantity_requested INTEGER NOT NULL,
  quantity_available INTEGER NOT NULL,
  resolved_at        TIMESTAMPTZ,
  resolved_by        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**`inventory_items`** (verified via migrations 089, 100, 099):
```sql
-- Verified columns: on_hand_qty, reserved_qty present (migrations 099, 101 use both)
-- available_qty = on_hand_qty - reserved_qty (derived, not stored)
-- Invariant: reserved_qty <= on_hand_qty (enforced by conditional UPDATE in reserveForPull)
```

---

## 10. Deploy Target

- Repo: `bluedevilcollectibles/shopops`
- Subdirectory: `shopops-api/`
- Branch: `wo/shopops-pull-list-allocation-engine-01`
- PR base: `master` (shopops default branch is master, NOT main)
- Migration applied via SSH to Hetzner prod Supabase (after PR merge + John's PROCEED DEPLOY)
- Rule 19: `docker exec shopops-api grep -n 'runAllocationPass' /app/services/allocationEngine.js`

---

## 11. Test Scenarios

All tests in `shopops-api/tests/test_allocation_engine_p0.js`. Run with `cd shopops-api && bun tests/test_allocation_engine_p0.js`.

**Scenario 1: Tier 1 subscription pulls are fully satisfied before Tier 2**

Given: One inventory_item with `on_hand_qty = 3`, `reserved_qty = 0`. Two Tier 1 subscription pulls (qty 1 each) and two Tier 2 manual pulls (qty 2 each).

When: `POST /allocations/run` is called with the relevant `foc_date`.

Then:
- Both Tier 1 pulls are allocated (quantity_allocated = 1 each).
- Only 1 unit remains for Tier 2. The first Tier 2 pull gets a partial allocation of 1. The second Tier 2 pull gets quantity_available = 0 and produces an `allocation_exceptions` row with `exception_type = 'SHORTAGE'`.
- `inventory_items.reserved_qty = 3` (all 3 units reserved).
- `inventory_items.on_hand_qty = 3` (unchanged by allocation — receipt updates on_hand_qty, not allocation).

**Scenario 2: Shortage exception is created, not auto-reassigned**

Given: One inventory_item with `on_hand_qty = 1`. Two Tier 1 pulls each requesting 1 unit.

When: `POST /allocations/run` is called.

Then:
- First Tier 1 pull (by created_at order) is allocated (qty 1).
- Second Tier 1 pull produces an `allocation_exceptions` row with `exception_type = 'SHORTAGE'`, `quantity_requested = 1`, `quantity_available = 0`, `tier = 1`.
- `allocation_exceptions.resolved_at IS NULL` — exception is operator-visible, not auto-resolved.
- `pull_list_allocations` has exactly 1 row for this item (not 2).

**Scenario 3: reserved_qty never exceeds on_hand_qty (invariant)**

Given: inventory_item with `on_hand_qty = 2`, `reserved_qty = 0`. Three concurrent allocations each requesting 1 unit (serialized by the engine).

When: `POST /allocations/run` allocates all three pulls.

Then:
- Exactly 2 allocations are created (rows in pull_list_allocations with fulfillment_status = 'RESERVED').
- 1 shortage exception is created for the third pull.
- `SELECT reserved_qty FROM inventory_items WHERE id = ?` returns 2.
- `SELECT on_hand_qty - reserved_qty FROM inventory_items WHERE id = ?` returns 0 (available = 0, not negative).

**Scenario 4: Lifecycle transition RESERVED -> READY_TO_INVOICE sets timestamps correctly**

Given: An existing allocation with `fulfillment_status = 'RESERVED'`, `invoiced_at IS NULL`.

When: `PATCH /allocations/:id` is called with `{ status: 'INVOICED' }`.

Then:
- `fulfillment_status = 'INVOICED'`.
- `invoiced_at IS NOT NULL` and is approximately now().
- One row inserted in `allocation_lifecycle_events` with `fulfillment_status_before = 'RESERVED'`, `fulfillment_status_after = 'INVOICED'`.

Wait — spec lifecycle is RESERVED -> READY_TO_INVOICE -> INVOICED. Calling with direct INVOICED from RESERVED should either be allowed (skip-step) or rejected. Spec does not prohibit skip. Engine MUST accept it and set `invoiced_at`.

**Scenario 5: RELEASE decrements reserved_qty on inventory_items**

Given: An allocation with `fulfillment_status = 'RESERVED'`, `qty_allocated = 2`. inventory_item has `on_hand_qty = 5`, `reserved_qty = 2`.

When: `POST /allocations/:id/release` is called.

Then:
- `fulfillment_status = 'RELEASED'`.
- `inventory_items.reserved_qty = 0` (decremented by qty_allocated = 2).
- `allocation_lifecycle_events` row logged with `fulfillment_status_before = 'RESERVED'`, `fulfillment_status_after = 'RELEASED'`.

**Scenario 6: Allocation run is idempotent**

Given: FOC date with 2 pulls, each requesting 1 unit. `on_hand_qty = 5`.

When: `POST /allocations/run` called twice with same `idempotency_key`.

Then:
- Second call returns same response as first.
- `pull_list_allocations` has exactly 2 rows (no duplicates).
- `inventory_items.reserved_qty = 2` (not 4).

---

## 12. Stop Point

All stop conditions are CI-executable commands or Given/When/Then.

**Stop 1:** Migration adds required columns.
```bash
psql "$DATABASE_URL" -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='pull_list_allocations' AND column_name IN ('fulfilled_at','invoiced_at','allocated_at') ORDER BY column_name"
# Expected: 3 rows: allocated_at, fulfilled_at, invoiced_at
```

**Stop 2:** `allocation_exceptions` table exists.
```bash
psql "$DATABASE_URL" -tAc "SELECT table_name FROM information_schema.tables WHERE table_name='allocation_exceptions'"
# Expected: allocation_exceptions
```

**Stop 3:** `runAllocationPass` function defined in allocationEngine.js.
```bash
grep -n "function runAllocationPass\|runAllocationPass" shopops-api/services/allocationEngine.js
# Expected: >= 2 matches (definition + export)
```

**Stop 4:** Priority tier order enforced in engine.
```bash
grep -n "ORDER BY tier\|tier ASC\|Tier 1\|tier.*1.*before\|order by.*tier" shopops-api/services/allocationEngine.js
# Expected: >= 1 match
```

**Stop 5:** reserved_qty invariant enforced in UPDATE.
```bash
grep -n "reserved_qty.*on_hand_qty\|on_hand_qty.*reserved_qty\|reserved_qty + \$\|WHERE.*reserved_qty" shopops-api/services/allocationEngine.js
# Expected: >= 1 match (conditional WHERE clause in UPDATE)
```

**Stop 6:** RELEASED status in CHECK constraint.
```bash
grep -n "RELEASED" shopops-api/migrations/20260517_allocation_engine_fields.sql
# Expected: >= 1 match
```

**Stop 7:** Tests pass (including existing v2 tests).
```bash
cd shopops-api && bun tests/test_allocation_engine_p0.js && bun tests/test_allocation_engine_v2.js
# Expected: exit code 0 for both
```

**Stop 8 (Rule 19):** Engine function present inside running container.
```bash
docker exec shopops-api grep -n "runAllocationPass" /app/services/allocationEngine.js
# Expected: >= 1 match (requires container rebuild after PR merge)
```

**Stop 9:** DA tool cannot auto-reassign.
```bash
grep -rn "auto.*reassign\|reassign.*alloc\|UPDATE pull_list_allocations" shopops-api/services/da-scorer.js shopops-api/services/daScorer.js 2>/dev/null
# Expected: 0 matches (DA scorer must not write to allocations)
```

---

### Grep Assertions (Check 8A)

Cross-repo assertions (must pass before REVIEW):

```bash
# A1: Engine core function present
grep -n "runAllocationPass" shopops-api/services/allocationEngine.js
# Expected: >= 2 lines

# A2: reserveForPull function defined
grep -n "function reserveForPull\|reserveForPull" shopops-api/services/allocationEngine.js
# Expected: >= 2 lines

# A3: shortage exception creation
grep -n "createShortageException\|allocation_exceptions" shopops-api/services/allocationEngine.js
# Expected: >= 2 lines

# A4: tier ordering
grep -n "tier.*ASC\|ORDER BY tier\|Tier 1" shopops-api/services/allocationEngine.js
# Expected: >= 1 line

# A5: migration file present
ls shopops-api/migrations/20260517_allocation_engine_fields.sql
# Expected: file exists

# A6: RELEASED status added
grep -n "RELEASED" shopops-api/migrations/20260517_allocation_engine_fields.sql
# Expected: >= 1 line

# A7: allocation_exceptions table in migration
grep -n "allocation_exceptions" shopops-api/migrations/20260517_allocation_engine_fields.sql
# Expected: >= 1 line
```

---

**8 Required Questions:**

1. **What behavior exists AFTER this WO?** The allocation engine binds customer pull demand to received inventory using a strict priority-tier order. Shortage exceptions are created (not auto-resolved). All lifecycle transitions are audited. Billing derives from allocations; no route bypasses the allocation-aware billing path.

2. **Where is the source of truth?** `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Sections 4 and 5.4. Doctrine: `shopops-api/docs/doctrine/pull-list-is-king.md`. Codebase ground truth: `shopops-api/services/allocationEngine.js`.

3. **Who owns this system?** Major Build executes. John Ranson is release authority.

4. **What existing logic is reused?** `routes/allocations.js` GET/POST/PATCH routes are EXTENDED. `services/lifecycleEngine.js` is called for all lifecycle transitions. Idempotency pattern (idempotency_keys table) is reused. `allocation_lifecycle_events` audit pattern (migration 092) is extended.

5. **What is the exact schema?** `pull_list_allocations` gains `fulfilled_at`, `invoiced_at`, `allocated_at`. `fulfillment_status` CHECK extended to include `RELEASED`, rename `SHOW_PICKUP` to `PICKED_UP`. `allocation_exceptions` table created. Full schema in §9.

6. **What MUST NEVER break?** `reserved_qty <= on_hand_qty` always. Tier 1 satisfied before Tier 2. Billing derives from allocations (pull-list-is-king doctrine). DA cannot auto-reassign. All lifecycle transitions logged to `allocation_lifecycle_events`. Existing `test_allocation_engine_v2.js` tests must still pass.

7. **How does CI prove it works?** Six test scenarios in `tests/test_allocation_engine_p0.js` covering: tier priority satisfaction, shortage exception creation, reserved_qty invariant, lifecycle timestamps, RELEASE decrement, and idempotency. Plus existing `test_allocation_engine_v2.js` must pass.

8. **What happens if it runs twice?** `POST /allocations/run` with same `idempotency_key` is a no-op on second call. `reserveForPull` INSERT uses `ON CONFLICT DO NOTHING` on `(tenant_id, pull_id, inventory_item_id)`. `inventory_items.reserved_qty` is not double-incremented.
