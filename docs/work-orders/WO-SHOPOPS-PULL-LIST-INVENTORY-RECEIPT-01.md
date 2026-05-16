# WO-SHOPOPS-PULL-LIST-INVENTORY-RECEIPT-01
<!-- wo-recipe.md 12-section template — see ~/.claude/reference/wo-recipe.md -->

**WO ID:** WO-SHOPOPS-PULL-LIST-INVENTORY-RECEIPT-01
**Priority:** P0
**Builder:** Codex
**Repo:** shopops-api (subdirectory of bluedevilcollectibles/shopops)
**GH Issue:** #118
**Status:** To Do
**Class:** CODE

---

## 1. Objective

Build the distributor shipment receipt path for Shop Ops HQ.

After this WO the following is true:
- Staff imports a distributor shipment manifest (POST /shipments/receive).
- Shop Ops HQ creates inventory items or increments `on_hand_qty` on existing items.
- The receipt engine matches received items to open `customer_pulls` via `solicitation_id` / `issue_id`.
- The allocation engine (`services/allocationEngine.js`, built by `WO-SHOPOPS-PULL-LIST-ALLOCATION-ENGINE-01`) is called to reserve subscriber/customer copies first, in priority-tier order.
- Remaining copies (on_hand_qty - reserved_qty) become the safe sellable quantity visible to channels.
- Channels CANNOT independently receive inventory. All inventory enters the system through Shop Ops HQ via this receipt path.

---

## 2. Behavior Source of Truth

Primary: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 5.3

From spec Section 5.3 (Receipt flow):
1. Staff imports distributor shipment.
2. Shop Ops HQ creates inventory items or increments existing.
3. Engine matches received items to open pulls.
4. Allocation engine reserves subscriber/customer copies first per priority tier.
5. Remaining copies become safe sellable quantity.

Rule: Imported shipment becomes inventory ONLY through Shop Ops HQ. Channels cannot independently receive inventory.

From spec Section 4 (Inventory Item fields):
```
tenant_id, inventory_item_id, issue_id, on_hand_qty, reserved_qty, available_qty,
cost, price, source, received_at
```

Invariants from spec Section 4:
- `reserved_qty <= on_hand_qty`
- `available_qty = max(0, on_hand_qty - reserved_qty)`

Secondary (existing codebase, verified 2026-05-16):
- `shopops-api/routes/shipments.js` — existing `POST /shipments/ingest` (PRH ingest) and `POST /shipments/mark-shipped`.
- `shopops-api/migrations/20260504_pull_list_scan_state.sql` — pull list scan state additions.
- `shopops-api/migrations/089_inventory_items_bpcomicid.sql` — inventory_items fields.
- `shopops-api/migrations/100_inventory_items_clz_fields.sql` — inventory_items CLZ fields.
- `shopops-api/routes/inventory.js` — existing inventory CRUD with `on_hand_qty`, `reserved_qty`, `sold_qty`.
- `shopops-api/tests/test_inventory_availability.js` — existing availability tests (MUST still pass).

---

## 3. Prior Art Check

Reference architecture spec: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 5.3

Existing `POST /shipments/ingest` (verified by reading shipments.js:108):
- Accepts `{ items: [{ upc, title, quantity, cost }], source }`.
- Matches by UPC → existing inventory_item (by `upc` or `bpcomicid`).
- If found: `UPDATE inventory_items SET on_hand_qty = on_hand_qty + qty`.
- If not found: `INSERT INTO inventory_items (tenant_id, title, upc, condition, on_hand_qty, reserved_qty, sold_qty, ...)`.
- DOES NOT call the allocation engine after receipt.
- DOES NOT match to `customer_pulls` or `solicitations`.
- DOES NOT compute `received_at` or `source` in the spec sense.

Gap vs. spec (what this WO adds):
- After incrementing/creating inventory, call `allocationEngine.runAllocationPass()` for the matched FOC date to reserve subscriber copies.
- Match received UPCs to `solicitations.upc` to find the `foc_date` and open `customer_pulls`.
- Add `received_at TIMESTAMPTZ` and `source TEXT` columns to `inventory_items` if not present.
- Add `WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01` dependency: this WO depends on safe `available_qty` computation (`available_qty = max(0, on_hand_qty - reserved_qty)` enforced at the database level).
- Rename existing `/shipments/ingest` to `/shipments/receive` (or add new route; keep backward compat alias).

---

## 4. System Context

**Dependencies (MUST exist before this WO executes):**
- `WO-SHOPOPS-PULL-LIST-CUSTOMER-PULL-MODEL-01` — `customer_pulls` table must exist with `pull_id`, `customer_id`, `issue_id`, `solicitation_id`, `quantity_requested`, `quantity_allocated`, `status`, `foc_date`.
- `WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01` — `available_qty` computed correctly (`max(0, on_hand_qty - reserved_qty)`); safe sellable quantity is the canonical read path for channels.
- `WO-SHOPOPS-PULL-LIST-ALLOCATION-ENGINE-01` — `services/allocationEngine.js:runAllocationPass()` must exist; called by this WO's receipt path.
- `inventory_items` table — must already exist (verified via migrations 089, 100).
- `solicitations` table — must exist with `upc`, `issue_id`, `foc_date`.

**Downstream consumers:**
- `routes/inventory.js` GET routes — read `on_hand_qty`, `reserved_qty` (MUST NOT break).
- `services/channel-adapter-ebay.js`, `services/channel-adapter-shopify.js` — read available_qty (MUST NOT break). Channels CANNOT call the receipt path.
- `WO-SHOPOPS-PULL-LIST-ALLOCATION-ENGINE-01` — allocation engine is called by the receipt path to reserve copies.
- `routes/distributor-orders.js` — may reference `distributor_orders` rows updated by receipt.

**Who owns this system:** Major Build executes. John Ranson is release authority.

---

## 5. UI Hierarchy

Per `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 5.3:

```
Shop Ops HQ (canonical authority)
  └── Inventory Receipt Engine (this WO)
        ├── POST /shipments/receive    -- NEW: full receipt path (matches pulls + triggers allocation)
        └── POST /shipments/ingest     -- EXISTING: kept for backward compat, aliased to /receive

Channels (read-only consumers of available_qty)
  ├── Shopify adapter  -- reads available_qty = max(0, on_hand_qty - reserved_qty)
  ├── eBay adapter     -- reads available_qty
  └── POS              -- reads available_qty
  (MUST NOT write to inventory_items.on_hand_qty independently)
```

---

## 6. Mode Behavior Matrix

| Operation | Input | Result | Idempotent? |
|---|---|---|---|
| POST /shipments/receive | { idempotency_key, distributor, items: [{ upc, title, quantity, cost_cents }] } | Creates/increments inventory_items; matches to solicitations; calls allocationEngine.runAllocationPass(); returns receipt summary | YES — idempotency_key |
| POST /shipments/receive (no matching solicitation) | Item with UPC not in solicitations | Creates inventory_item with `source = 'unmatched_receipt'`; NO allocation pass (no pulls to satisfy) | YES |
| POST /shipments/receive (duplicate) | Same idempotency_key, second call | Returns existing receipt result; on_hand_qty NOT incremented again | YES |
| POST /shipments/ingest | Same as before (backward compat) | Delegates to /receive logic | YES |
| Channel reads available_qty | GET /inventory or channel sync | Returns max(0, on_hand_qty - reserved_qty) | YES — read-only |
| Channel attempts to write on_hand_qty | Any write to inventory_items via channel adapter | REJECTED — channels are read-only consumers | N/A |

---

## 7. Backend Function Inventory

All functions labeled NEW or EXISTING (file:line) per wo-recipe.md.

| Function | Status | Notes |
|---|---|---|
| `POST /shipments/ingest` route | EXISTING (shipments.js:108) | Keep as backward compat alias; delegate to new `receiveShipment()` handler |
| `POST /shipments/receive` route | NEW | Full receipt path: validate, upsert inventory_items, match solicitations, call allocationEngine.runAllocationPass() |
| `receiveShipment(client, tenantId, idempotencyKey, distributor, items)` | NEW | Core receipt function. Iterates items, matches UPC to inventory_items and solicitations, calls allocationEngine. |
| `matchUpcToSolicitation(client, tenantId, upc)` | NEW | SELECT from solicitations WHERE upc = ? AND status = 'active'. Returns { solicitation_id, foc_date, issue_id } or null. |
| `upsertInventoryItem(client, tenantId, item, solicitation)` | NEW | UPDATE on_hand_qty + received_at if exists; INSERT if not. Returns inventory_item_id. |
| `computeContentHash(items)` | EXISTING (shipments.js:20) | Reused for batch-level dedup. No change. |
| `allocationEngine.runAllocationPass(client, tenantId, focDate)` | EXISTING after WO-ALLOC (allocationEngine.js) | Called after inventory upsert for each matched foc_date. |
| `services/pull-outputs.js` | EXISTING (pull-outputs.js) | Called to update pull status after allocation pass. No change to this file. |

Migrations:
| Migration | Status | Notes |
|---|---|---|
| `20260517_inventory_items_receipt_fields.sql` | NEW | ADD COLUMN received_at TIMESTAMPTZ, source TEXT; add shipment_receipts table |

---

## 8. Data Flow

```
staff / import UI
  |
  v
POST /shipments/receive { idempotency_key, distributor, items }
  |--[0]--> idempotency check: if key exists -> return cached response
  |
  v
receiveShipment(client, tenantId, idempotencyKey, distributor, items)
  |--[1]--> computeContentHash(items) -- batch dedup guard
  |--[2]--> INSERT INTO shipment_receipts (tenant_id, distributor, content_hash, idempotency_key, received_at)
  |           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING -> if no-op, return cached
  |
  |  For each item in items:
  |--[3]--> matchUpcToSolicitation(client, tenantId, item.upc)
  |           -> { solicitation_id, foc_date, issue_id } or null
  |--[4]--> upsertInventoryItem(client, tenantId, item, solicitation)
  |           IF existing (by upc + tenant_id + deleted_at IS NULL):
  |             UPDATE inventory_items SET on_hand_qty = on_hand_qty + item.quantity,
  |                    received_at = now(), source = distributor WHERE id = existing.id
  |           ELSE:
  |             INSERT INTO inventory_items (tenant_id, title, upc, on_hand_qty, reserved_qty=0,
  |                    issue_id, cost_cents, source=distributor, received_at=now())
  |--[5]--> IF solicitation matched: collect foc_date into Set<foc_dates>
  |
  |  After all items processed:
  |--[6]--> For each unique foc_date in foc_dates:
  |           allocationEngine.runAllocationPass(client, tenantId, foc_date)
  |
  |--[7]--> Compute receipt summary:
  |           { items_received, items_created, items_incremented, foc_dates_processed,
  |             allocations_created, shortage_exceptions }
  |--[8]--> Cache response in idempotency_keys table
  |--[9]--> COMMIT
  |
  v
respond { ok: true, receipt_id, summary }
```

**What MUST NEVER break (invariants):**
- `reserved_qty <= on_hand_qty` — enforced by allocation engine conditional UPDATE.
- `available_qty = max(0, on_hand_qty - reserved_qty)` — derived, never stored independently.
- Channels CANNOT write to `inventory_items.on_hand_qty`. Receipt is the only write path.
- `shipment_receipts` row is inserted BEFORE inventory is modified; if crash occurs mid-receipt, re-running with same idempotency_key returns cached response.
- `on_hand_qty` is NEVER decremented by the receipt engine (only incremented on receipt, decremented by sales/PATCH).

**Idempotency:** `idempotency_key` is checked before any writes. If the key exists in `idempotency_keys` table, the cached response is returned without re-incrementing `on_hand_qty`.

---

## 9. Database Schema References

All column claims verified against migrations directory (2026-05-16).

**`inventory_items`** (verified via migrations 089, 100, 101, and shipments.js:171-196):
```sql
-- Verified current columns from shipments.js:196 INSERT statement:
-- tenant_id, title, upc, condition, on_hand_qty, reserved_qty, sold_qty
-- bpcomicid (added migration 089)
-- key_level, key_categories, key_reason, is_slabbed, fmv_cents (added migration 100)

-- NEW via 20260517_inventory_items_receipt_fields.sql:
ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS received_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source       TEXT,
  ADD COLUMN IF NOT EXISTS issue_id     UUID REFERENCES solicitations(id);

-- Invariant (from spec Section 4):
-- reserved_qty <= on_hand_qty (enforced by allocationEngine conditional UPDATE)
-- available_qty = max(0, on_hand_qty - reserved_qty) (derived, per WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01)
```

**`shipment_receipts`** (NEW table):
```sql
CREATE TABLE IF NOT EXISTS shipment_receipts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT NOT NULL,
  distributor      TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  item_count       INTEGER NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  summary          JSONB,
  CONSTRAINT shipment_receipts_tenant_key_uniq UNIQUE (tenant_id, idempotency_key)
);
```

**`solicitations`** (verified via foc.js:49 SELECT):
```sql
-- Columns used for matching: id, upc, foc_date, status
-- Match query: SELECT id AS solicitation_id, foc_date FROM solicitations
--              WHERE upc = $1 AND tenant_id = current_setting('app.tenant_id', true) AND status = 'active'
```

**`customer_pulls`** (verified via migration 20260507_pull_list_state_machine.sql):
```sql
-- Columns used by allocationEngine after receipt:
-- pull_id (id), customer_id, issue_id, solicitation_id, quantity_requested,
-- quantity_allocated, status, foc_date, deleted_at
```

---

## 10. Deploy Target

- Repo: `bluedevilcollectibles/shopops`
- Subdirectory: `shopops-api/`
- Branch: `wo/shopops-pull-list-inventory-receipt-01`
- PR base: `master` (shopops default branch is master, NOT main)
- Migration applied via SSH to Hetzner prod Supabase (after PR merge + John's PROCEED DEPLOY)
- Rule 19: `docker exec shopops-api grep -n 'receiveShipment' /app/routes/shipments.js`

---

## 11. Test Scenarios

All tests in `shopops-api/tests/test_inventory_receipt.js`. Run with `cd shopops-api && bun tests/test_inventory_receipt.js`.

**Scenario 1: Receipt creates new inventory item and triggers allocation pass**

Given: A solicitation with `upc = '75960621516400611'`, `foc_date = '2026-06-04'`. Two active customer pulls (Tier 1 subscription, qty 1 each). No existing inventory_item for this UPC.

When: `POST /shipments/receive` is called with `{ idempotency_key: "recv-test-1", distributor: "prh", items: [{ upc: "75960621516400611", title: "Test Comic #1", quantity: 5, cost_cents: 199 }] }`.

Then:
- HTTP 200 with `{ ok: true, summary: { items_created: 1, items_incremented: 0, foc_dates_processed: 1, ... } }`.
- `inventory_items` has 1 row for UPC `75960621516400611` with `on_hand_qty = 5`.
- Allocation engine ran: both Tier 1 pulls are allocated (`reserved_qty = 2`).
- `available_qty = max(0, 5 - 2) = 3` — 3 units are safe sellable quantity.
- `inventory_items.received_at IS NOT NULL`.
- `inventory_items.source = 'prh'`.

**Scenario 2: Receipt increments on_hand_qty on existing inventory item**

Given: An existing inventory_item for UPC `'76194123456789'` with `on_hand_qty = 3`, `reserved_qty = 1`.

When: `POST /shipments/receive` is called with 4 units of the same UPC.

Then:
- HTTP 200.
- `inventory_items.on_hand_qty = 7` (3 + 4).
- `reserved_qty` unchanged = 1 (allocation engine may run if there are open pulls; if no open pulls, reserved_qty stays 1).
- `inventory_items.received_at` updated to approximately now().
- `summary.items_incremented = 1`, `summary.items_created = 0`.

**Scenario 3: Receipt with no matching solicitation creates unmatched inventory**

Given: UPC `'00000000000000'` not present in any solicitation.

When: `POST /shipments/receive` is called with this UPC.

Then:
- HTTP 200.
- `inventory_items` row created with `on_hand_qty = quantity`, `source = 'unmatched_receipt'`, `issue_id IS NULL`.
- Allocation engine is NOT called (no foc_date to process).
- `summary.foc_dates_processed = 0`.

**Scenario 4: Receipt is idempotent — same idempotency_key second call does not double-increment**

Given: Scenario 1 completed (5 units received for UPC `75960621516400611`).

When: `POST /shipments/receive` is called again with the same `idempotency_key = "recv-test-1"`.

Then:
- HTTP 200 with the same response as the first call.
- `inventory_items.on_hand_qty` is still 5 (NOT 10).
- `shipment_receipts` has exactly 1 row for `idempotency_key = "recv-test-1"`.

**Scenario 5: reserved_qty invariant holds after receipt and allocation**

Given: Solicitation with `on_hand_qty = 0` before receipt. Three active customer pulls (qty 1 each, Tier 1).

When: `POST /shipments/receive` is called with 2 units.

Then:
- `inventory_items.on_hand_qty = 2`.
- `inventory_items.reserved_qty = 2` (both units reserved for 2 of the 3 pulls).
- `reserved_qty <= on_hand_qty` holds (2 <= 2).
- `available_qty = max(0, 2 - 2) = 0` — safe sellable = 0 (all reserved).
- `allocation_exceptions` has 1 row for the third pull (SHORTAGE, qty_requested=1, qty_available=0).

**Scenario 6: Channel adapter cannot write on_hand_qty**

Given: Channel adapters (channel-adapter-shopify.js, channel-adapter-ebay.js) are the only non-receipt write paths to inventory.

When: Search codebase for direct INSERT/UPDATE on `inventory_items.on_hand_qty` outside of shipments.js and inventory.js.

Then:
```bash
grep -rn "on_hand_qty" shopops-api/services/channel-adapter-shopify.js shopops-api/services/channel-adapter-ebay.js 2>/dev/null
# Expected: 0 matches (channels are read-only for on_hand_qty)
```

---

## 12. Stop Point

All stop conditions are CI-executable commands or Given/When/Then.

**Stop 1:** Migration adds receipt fields to inventory_items.
```bash
psql "$DATABASE_URL" -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='inventory_items' AND column_name IN ('received_at','source') ORDER BY column_name"
# Expected: 2 rows: received_at, source
```

**Stop 2:** `shipment_receipts` table exists.
```bash
psql "$DATABASE_URL" -tAc "SELECT table_name FROM information_schema.tables WHERE table_name='shipment_receipts'"
# Expected: shipment_receipts
```

**Stop 3:** `POST /shipments/receive` route defined.
```bash
grep -n "router.post.*receive\|/shipments/receive" shopops-api/routes/shipments.js
# Expected: >= 1 match
```

**Stop 4:** `receiveShipment` function defined.
```bash
grep -n "function receiveShipment\|receiveShipment" shopops-api/routes/shipments.js
# Expected: >= 2 matches (definition + call)
```

**Stop 5:** Allocation engine is called after receipt.
```bash
grep -n "runAllocationPass\|allocationEngine" shopops-api/routes/shipments.js
# Expected: >= 1 match
```

**Stop 6:** `matchUpcToSolicitation` function defined.
```bash
grep -n "function matchUpcToSolicitation\|matchUpcToSolicitation" shopops-api/routes/shipments.js
# Expected: >= 2 matches
```

**Stop 7:** Tests pass (including existing availability tests).
```bash
cd shopops-api && bun tests/test_inventory_receipt.js && bun tests/test_inventory_availability.js
# Expected: exit code 0 for both
```

**Stop 8 (Rule 19):** Receipt route present inside running container.
```bash
docker exec shopops-api grep -n "receiveShipment" /app/routes/shipments.js
# Expected: >= 1 match (requires container rebuild after PR merge)
```

**Stop 9:** Channels cannot write on_hand_qty.
```bash
grep -rn "on_hand_qty" shopops-api/services/channel-adapter-shopify.js shopops-api/services/channel-adapter-ebay.js 2>/dev/null
# Expected: 0 lines (zero matches — channels read only)
```

**Stop 10:** Idempotency key in shipment_receipts unique constraint.
```bash
grep -n "idempotency_key.*UNIQUE\|UNIQUE.*idempotency_key\|tenant_key_uniq" shopops-api/migrations/20260517_inventory_items_receipt_fields.sql
# Expected: >= 1 match
```

---

### Grep Assertions (Check 8A)

Cross-repo assertions (must pass before REVIEW):

```bash
# A1: receive route defined
grep -n "router.post.*receive\|/receive" shopops-api/routes/shipments.js
# Expected: >= 1 line

# A2: matchUpcToSolicitation connects receipt to pulls
grep -n "matchUpcToSolicitation\|solicitations.*upc\|upc.*solicitations" shopops-api/routes/shipments.js
# Expected: >= 2 lines

# A3: allocationEngine called from receipt path
grep -n "runAllocationPass\|allocationEngine.run" shopops-api/routes/shipments.js
# Expected: >= 1 line

# A4: received_at set in upsert
grep -n "received_at" shopops-api/routes/shipments.js
# Expected: >= 2 lines (INSERT and UPDATE paths)

# A5: migration file present
ls shopops-api/migrations/20260517_inventory_items_receipt_fields.sql
# Expected: file exists

# A6: shipment_receipts table in migration
grep -n "shipment_receipts" shopops-api/migrations/20260517_inventory_items_receipt_fields.sql
# Expected: >= 2 lines (CREATE TABLE + UNIQUE constraint)

# A7: channel adapters do NOT write on_hand_qty
grep -rn "on_hand_qty" shopops-api/services/channel-adapter-shopify.js shopops-api/services/channel-adapter-ebay.js 2>/dev/null | wc -l
# Expected: 0
```

---

**8 Required Questions:**

1. **What behavior exists AFTER this WO?** Staff imports a distributor shipment via `POST /shipments/receive`. Inventory items are created or incremented. The receipt engine matches UPCs to solicitations, then calls the allocation engine to reserve subscriber/customer copies in priority-tier order. Remaining copies (available_qty) are safe sellable quantity for channels. Channels cannot write to inventory independently.

2. **Where is the source of truth?** `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 5.3. Codebase ground truth: `shopops-api/routes/shipments.js`.

3. **Who owns this system?** Major Build executes. John Ranson is release authority.

4. **What existing logic is reused?** `POST /shipments/ingest` is kept as a backward-compat alias. `computeContentHash()` (shipments.js:20) is reused for batch dedup. `allocationEngine.runAllocationPass()` (from WO-SHOPOPS-PULL-LIST-ALLOCATION-ENGINE-01) is called after inventory upsert. Idempotency_keys pattern is reused.

5. **What is the exact schema?** `inventory_items` gains `received_at TIMESTAMPTZ`, `source TEXT`, `issue_id UUID`. `shipment_receipts` table is created with UNIQUE (tenant_id, idempotency_key). Full schema in §9.

6. **What MUST NEVER break?** `reserved_qty <= on_hand_qty`. `available_qty = max(0, on_hand_qty - reserved_qty)`. Channels cannot write `on_hand_qty` — receipt is the only write path. `on_hand_qty` is never decremented by the receipt engine. Idempotency: same `idempotency_key` never double-increments. Existing `test_inventory_availability.js` must pass.

7. **How does CI prove it works?** Six test scenarios in `tests/test_inventory_receipt.js` covering: new item creation with allocation, on_hand_qty increment, unmatched UPC, idempotency, reserved_qty invariant under shortage, and channel write-path guard. Plus existing `test_inventory_availability.js` must pass.

8. **What happens if it runs twice?** `idempotency_key` check in `shipment_receipts` table (UNIQUE constraint) prevents double-increment of `on_hand_qty`. Second call with same key returns cached response from the first call without writing to `inventory_items`.
