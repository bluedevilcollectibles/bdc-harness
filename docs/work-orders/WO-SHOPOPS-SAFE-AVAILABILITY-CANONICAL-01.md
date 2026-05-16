# WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01 — Canonical Safe-Availability Primitive

**WO ID:** WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01
**Priority:** P1
**Builder:** Codex
**Repo:** shopops-api
**GitHub Issue:** #113
**Status:** To Do
**Created:** 2026-05-16
**Reference:** wo-recipe.md (12-section format)

---

## 1. Objective

Implement the canonical safe-availability primitive for Shop Ops HQ. A single SQL view and a
service-layer function compute:

```
safe_available_qty = MAX(0, on_hand_qty - reserved_qty - channel_listed_elsewhere_qty)
```

Every buyer-facing surface — storefront API, POS inventory lookup, channel export feeds — MUST
consume this primitive exclusively. Staff surfaces (internal inventory dashboard, receiving
screen) MAY additionally display raw `on_hand_qty` and `reserved_qty` with clear labels, but
MUST NOT expose raw `on_hand_qty` as the sellable figure to buyers.

Deliver:
1. A PostgreSQL view `v_inventory_availability` that computes all three quantities per
   `(tenant_id, inventory_item_id)`.
2. A service function `getSafeAvailability(tenantId, inventoryItemId)` that queries the view.
3. A service function `getSafeAvailabilityBatch(tenantId, inventoryItemIds[])` for bulk lookups.
4. A REST endpoint `GET /api/inventory/:itemId/availability` that returns the safe figure for
   buyer-facing consumers.
5. Unit + integration tests for the formula, the zero-floor invariant, and the endpoint.

**What behavior exists AFTER this WO?**
After this WO, no buyer-facing code path reads `on_hand_qty` directly from `inventory_items`.
All buyer-facing quantity reads go through `v_inventory_availability.safe_available_qty`. Staff
dashboards may additionally display labeled raw and reserved quantities. The zero-floor invariant
(`safe_available_qty >= 0`) is enforced in the view, not in application code.

---

## 2. Behavior Source of Truth

Primary plan document:
`docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Section 5.5 — Safe Availability.

All column names, formula variables, and invariants in this WO derive exclusively from that plan
document. No names are invented.

Secondary references:
- `wo-recipe.md` — 12-section WO template (authoring compliance)
- `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` (canonical spec)

**Where is the source of truth?**
The plan document at `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Section 5.5 is the authoritative definition of the safe-availability formula, the minimum
availability invariant, and which surfaces may display which quantities. Supabase staging schema
is ground truth for actual column existence.

---

## 3. Prior Art Check

**Plan document consulted:** `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Section 5.5, Safe Availability.

No existing `v_inventory_availability` view or `getSafeAvailability` function has been found in
the shopops-api codebase at WO authoring time. Builder MUST run before writing any code:

```sql
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('v_inventory_availability', 'inventory_items');
```

If `inventory_items` does not exist, this WO is BLOCKED — it depends on the inventory_items
table being present. Surface blocker immediately rather than creating a stub.

Existing files to check:
- `shopops-api/db/views/` — any prior availability view
- `shopops-api/services/inventory*` — any existing inventory service
- `shopops-api/routes/inventory*` — any existing inventory route

---

## 4. System Context

**Owner:** Blue Devil Collectibles (BDC). John Ranson is sole release authority.

**Repo:** `bluedevilcollectibles/shopops-api` (Node.js ES modules, Supabase/PostgreSQL)

**Dependencies this WO requires:**
- `inventory_items` table must exist in Supabase staging with columns: `tenant_id`,
  `inventory_item_id`, `on_hand_qty`, `reserved_qty`, `available_qty` (builder MUST verify via
  `information_schema` — see §9)
- A `channel_listings` table or equivalent must exist to derive `channel_listed_elsewhere_qty`
  OR the formula falls back to `available_qty = MAX(0, on_hand_qty - reserved_qty)` until
  channel listing tracking is implemented (builder MUST check and document which applies)
- Supabase staging instance accessible
- `shopops-api` running with Node/Bun test runner
- GitHub CLI authenticated

**Adjacent WOs:**
- WO-SHOPOPS-CUSTOMER-IDENTITY-BINDING-01 (#112) — no schema overlap, safe to run in parallel
- WO-SHOPOPS-PULL-LIST-CUSTOMER-PULL-MODEL-01 (#115) — pull allocation logic will call
  `getSafeAvailability` to gate allocation; this WO MUST reach REVIEW first

**Who owns this system?**
Blue Devil Collectibles. General owns architecture decisions; Major Build owns execution.

**What MUST NEVER break? (invariants)**
1. `safe_available_qty` MUST NEVER be negative. The view enforces `GREATEST(0, ...)`.
2. `available_qty = GREATEST(0, on_hand_qty - reserved_qty)` is the minimum invariant —
   safe_available_qty may only be less-than-or-equal-to available_qty.
3. Buyer-facing API responses MUST NOT contain the field `on_hand_qty` — only
   `safe_available_qty` (and optionally `available_qty` for authenticated staff).
4. `tenant_id` isolation: a query for tenant A must never return inventory rows for tenant B.
   The view must always filter on `tenant_id`.

---

## 5. UI Hierarchy

No frontend UI changes in this WO. The primitive is consumed by:

1. **Storefront API** (`GET /api/storefront/products/:id`) — must switch to `safe_available_qty`
   from `on_hand_qty`. Builder must locate and update this call site.
2. **POS inventory lookup** (`GET /api/pos/inventory/:itemId`) — same switch required.
3. **Channel export feeds** (Shopify product sync, LOCG stock file) — must use
   `getSafeAvailabilityBatch` for bulk export.
4. **Staff internal dashboard** — MAY display all three quantities with labels:
   `on_hand_qty` (raw), `reserved_qty`, `safe_available_qty` (sellable). No UI work in this WO;
   this is a documented permission for the future dashboard WO.
5. **New REST endpoint** `GET /api/inventory/:itemId/availability` — returns:
   ```json
   { "inventoryItemId": "...", "safeAvailableQty": 3, "availableQty": 5 }
   ```
   Staff token additionally receives `onHandQty` and `reservedQty`.

Reference: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 5.5.

---

## 6. Mode Behavior Matrix

| Surface | Can See on_hand_qty | Can See reserved_qty | Can See safe_available_qty | Notes |
|---|---|---|---|---|
| Buyer storefront | NO | NO | YES (only field shown) | Never expose raw inventory |
| POS (buyer transaction) | NO | NO | YES | Same rule as storefront |
| Channel export (Shopify, LOCG) | NO | NO | YES | Use batch function |
| Staff internal dashboard | YES (labeled) | YES (labeled) | YES | All three, clearly labeled |
| Pull allocation gate | NO | NO | YES | Gating check before allocation |
| Admin raw inventory report | YES | YES | YES | Authenticated admin only |

**Formula variants:**

Full formula (when `channel_listings` table exists):
```
safe_available_qty = GREATEST(0, on_hand_qty - reserved_qty - channel_listed_elsewhere_qty)
```

Minimum fallback (if channel listing tracking not yet implemented):
```
available_qty = GREATEST(0, on_hand_qty - reserved_qty)
```

Builder MUST determine which formula applies based on actual schema, document the finding in the
PR, and implement accordingly. The view MUST be named `v_inventory_availability` regardless of
which formula variant is used.

**What happens if it runs twice? (idempotency)**
The view creation uses `CREATE OR REPLACE VIEW v_inventory_availability`. Running the migration
twice is safe — it replaces the view definition idempotently. `getSafeAvailability` is a
read-only query — calling it twice with the same arguments returns the same result with no
side effects.

---

## 7. Backend Function Inventory

| Function | File | Status | Notes |
|---|---|---|---|
| `getSafeAvailability(tenantId, inventoryItemId)` | `services/inventoryAvailability.js` | NEW | Single-item lookup via view |
| `getSafeAvailabilityBatch(tenantId, itemIds[])` | `services/inventoryAvailability.js` | NEW | Bulk lookup, returns Map |
| `GET /api/inventory/:itemId/availability` | `routes/inventory.js` | NEW | REST endpoint, staff vs buyer response |
| View migration | `db/migrations/YYYYMMDD_v_inventory_availability.sql` | NEW | CREATE OR REPLACE VIEW |
| Storefront route patch | `routes/storefront.js` | EXISTING — builder must locate actual file | Switch to safe qty |
| POS route patch | `routes/pos.js` | EXISTING — builder must locate actual file | Switch to safe qty |

Builder MUST verify existing file paths:
```bash
ls shopops-api/routes/ | grep -E "storefront|pos|inventory"
ls shopops-api/services/ | grep -E "inventory"
```
Adjust filenames to match actual structure.

---

## 8. Data Flow

```
Buyer request: GET /api/inventory/:itemId/availability
  |
  v
routes/inventory.js (authMiddleware — determines buyer vs staff token)
  |
  v
getSafeAvailability(tenantId, inventoryItemId)
  |
  v
SELECT safe_available_qty, available_qty [, on_hand_qty, reserved_qty for staff]
FROM v_inventory_availability
WHERE tenant_id = $1 AND inventory_item_id = $2
  |
  v
v_inventory_availability (SQL view):
  SELECT
    tenant_id,
    inventory_item_id,
    on_hand_qty,
    reserved_qty,
    COALESCE(channel_listed_elsewhere_qty, 0) AS channel_listed_elsewhere_qty,
    GREATEST(0, on_hand_qty - reserved_qty) AS available_qty,
    GREATEST(0, on_hand_qty - reserved_qty
             - COALESCE(channel_listed_elsewhere_qty, 0)) AS safe_available_qty
  FROM inventory_items
  LEFT JOIN (
    SELECT inventory_item_id, SUM(listed_qty) AS channel_listed_elsewhere_qty
    FROM channel_listings
    WHERE tenant_id = $tenant_id
    GROUP BY inventory_item_id
  ) cl USING (inventory_item_id)
  |
  v
Response (buyer): { safeAvailableQty: N }
Response (staff): { safeAvailableQty: N, availableQty: N, onHandQty: N, reservedQty: N }
```

**Cross-repo note (bdc-xo):** Spec lives in `bluedevilcollectibles/bdc-xo`. Implementation in
`bluedevilcollectibles/shopops-api`. YAML workflow fetches spec at runtime via `gh api`.

### Grep Assertions (Check 8A — bdc-xo cross-repo)

```bash
grep -r "getSafeAvailability" shopops-api/services/ | grep -q "." \
  || (echo "FAIL: getSafeAvailability not in services/" && exit 1)

grep -r "v_inventory_availability" shopops-api/db/ | grep -q "." \
  || (echo "FAIL: view migration not in db/" && exit 1)

grep -r "GREATEST" shopops-api/db/ | grep -q "." \
  || (echo "FAIL: GREATEST not in view migration" && exit 1)

grep -r "on_hand_qty" shopops-api/routes/ | grep -v "inventoryAvailability\|staff" | grep -q "." \
  && (echo "WARN: on_hand_qty exposed in buyer route — verify it is staff-gated" >&2) || true

grep -r "safe_available_qty\|safeAvailableQty" shopops-api/routes/ | grep -q "." \
  || (echo "FAIL: safe qty not referenced in any route" && exit 1)
```

---

## 9. Database Schema References

### `inventory_items` table (EXISTING — builder MUST verify)

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'inventory_items'
ORDER BY ordinal_position;
```

Expected columns (from plan doc Section 4):
| Column | Type | Nullable |
|---|---|---|
| `tenant_id` | uuid | NO |
| `inventory_item_id` | uuid (PK) | NO |
| `issue_id` | uuid (FK) | YES |
| `on_hand_qty` | integer | NO (default 0) |
| `reserved_qty` | integer | NO (default 0) |
| `available_qty` | integer | YES (computed or stored) |
| `cost` | numeric | YES |
| `price` | numeric | YES |
| `source` | text | YES |
| `received_at` | timestamptz | YES |

If `available_qty` is a stored column, the view may need to override its value with the formula.

### `channel_listings` table (builder MUST verify existence)

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'channel_listings';
```

If this table does not exist, builder uses the minimum-fallback formula and documents the gap.

### `v_inventory_availability` view (NEW — this WO creates it)

Migration: `shopops-api/db/migrations/YYYYMMDD_v_inventory_availability.sql`

```sql
CREATE OR REPLACE VIEW v_inventory_availability AS
SELECT
  ii.tenant_id,
  ii.inventory_item_id,
  ii.on_hand_qty,
  ii.reserved_qty,
  COALESCE(cl.channel_listed_elsewhere_qty, 0) AS channel_listed_elsewhere_qty,
  GREATEST(0, ii.on_hand_qty - ii.reserved_qty)                                    AS available_qty,
  GREATEST(0, ii.on_hand_qty - ii.reserved_qty
             - COALESCE(cl.channel_listed_elsewhere_qty, 0))                       AS safe_available_qty
FROM inventory_items ii
LEFT JOIN (
  SELECT tenant_id, inventory_item_id, SUM(listed_qty) AS channel_listed_elsewhere_qty
  FROM channel_listings
  GROUP BY tenant_id, inventory_item_id
) cl ON cl.tenant_id = ii.tenant_id
     AND cl.inventory_item_id = ii.inventory_item_id;
```

Column claims are sourced from plan doc Section 5.5. Builder MUST verify with `information_schema`
query above before finalizing the view DDL.

---

## 10. Deploy Target

- **Platform:** `shopops-api` (Node.js, Docker on BDC server)
- **Environment:** Staging Supabase only until John approves production deploy
- **View apply:** `psql $SUPABASE_DB_URL < shopops-api/db/migrations/YYYYMMDD_v_inventory_availability.sql`
- **Runtime verify (Rule 19):**
  ```bash
  docker exec shopops-api grep -n "getSafeAvailability\|v_inventory_availability" \
    /app/services/inventoryAvailability.js 2>&1
  ```
  Container not rebuilt = `STATUS=skipped_container_not_rebuilt` with RULE19_RERUN command in manifest.
- **No production deploy** without John's explicit "PROCEED DEPLOY."

---

## 11. Test Scenarios

Tests: `shopops-api/tests/inventoryAvailability.test.js`. All tests run against staging Supabase
(not mocks) per Rule 16.

**Test 1 — Formula correctness: basic case**

Given: `inventory_items` row with `on_hand_qty=10`, `reserved_qty=3`, no channel listings
When: `getSafeAvailability(tenantId, itemId)` is called
Then:
- Returns `{ safeAvailableQty: 7, availableQty: 7 }`
- Assert: `safe_available_qty = GREATEST(0, 10 - 3 - 0) = 7`

**Test 2 — Zero-floor invariant enforced**

Given: `inventory_items` row with `on_hand_qty=2`, `reserved_qty=5` (over-reserved)
When: `getSafeAvailability(tenantId, itemId)` is called
Then:
- Returns `{ safeAvailableQty: 0, availableQty: 0 }`
- Neither `safeAvailableQty` nor `availableQty` is negative
- Assert: result.safeAvailableQty >= 0

**Test 3 — Channel listed elsewhere reduces safe qty**

Given: `on_hand_qty=10`, `reserved_qty=2`, `channel_listed_elsewhere_qty=4` (4 units listed on eBay)
When: `getSafeAvailability(tenantId, itemId)` is called
Then:
- `availableQty = GREATEST(0, 10 - 2) = 8`
- `safeAvailableQty = GREATEST(0, 10 - 2 - 4) = 4`
- Both values returned correctly

**Test 4 — Tenant isolation**

Given: Two tenants (tenantA, tenantB) each have an item with the same `inventory_item_id`
When: `getSafeAvailability('tenantA', itemId)` is called
Then:
- Returns quantities for tenantA only
- tenantB's `on_hand_qty` is not included in the result
- `getSafeAvailability('tenantB', itemId)` returns tenantB's separate quantities

**Test 5 — REST endpoint: buyer response omits raw fields**

Given: a valid `inventory_item_id` exists for tenantId
When: `GET /api/inventory/:itemId/availability` is called with a buyer-scoped JWT
Then:
- HTTP 200
- Response body contains `safeAvailableQty` (number >= 0)
- Response body does NOT contain `onHandQty` or `reservedQty`
- Assert: `'onHandQty' in response === false`

**Test 6 — REST endpoint: staff response includes all fields**

Given: same `inventory_item_id`
When: `GET /api/inventory/:itemId/availability` with a staff JWT
Then:
- HTTP 200
- Response contains `safeAvailableQty`, `availableQty`, `onHandQty`, `reservedQty` — all labeled

**How does CI prove it works?**
```bash
cd shopops-api && bun test tests/inventoryAvailability.test.js
```
All 6 tests must pass. CI runs on every PR.

---

## 12. Stop Point

**Stop 1 — View exists in staging**
```bash
psql "$SUPABASE_DB_URL" -c "SELECT safe_available_qty FROM v_inventory_availability LIMIT 1;" \
  && echo "PASS: view queryable" || (echo "FAIL: view missing or broken" && exit 1)
```

**Stop 2 — Zero-floor invariant holds across all rows**
```bash
psql "$SUPABASE_DB_URL" -c \
  "SELECT COUNT(*) FROM v_inventory_availability WHERE safe_available_qty < 0;" \
  | grep -q "^[ ]*0" \
  && echo "PASS: no negative safe_available_qty" || (echo "FAIL: negative values found" && exit 1)
```

**Stop 3 — Unit tests pass**
```bash
cd shopops-api && bun test tests/inventoryAvailability.test.js
# Exit code 0, output contains "6 pass"
```

**Stop 4 — on_hand_qty not exposed in buyer route**

Given: buyer JWT available as `$BUYER_TOKEN`, staging URL as `$STAGING_URL`, a valid `$ITEM_ID`
When:
```bash
curl -s -H "Authorization: Bearer $BUYER_TOKEN" \
  "$STAGING_URL/api/inventory/$ITEM_ID/availability" | jq 'has("onHandQty")'
```
Then: output is `false`

**Stop 5 — Grep assertions pass**
```bash
grep -r "getSafeAvailability" shopops-api/services/inventoryAvailability.js | grep -q "." \
  && echo "PASS" || (echo "FAIL" && exit 1)
grep -r "GREATEST" shopops-api/db/ | grep -q "." \
  && echo "PASS" || (echo "FAIL" && exit 1)
```

**Stop 6 — Rule 19 runtime verify**
```bash
docker exec shopops-api grep -n "getSafeAvailability" /app/services/inventoryAvailability.js 2>&1 \
  && echo "STATUS=ok" || echo "STATUS=skipped_container_not_rebuilt"
```

**Stop 7 — PR opened against shopops-api/main**

Given: stops 1–6 pass
When: `gh pr view --repo bluedevilcollectibles/shopops-api --json state,title` is run
Then: `state=OPEN`, title contains `WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01`, body contains `Closes #113`

All 7 stops must appear in the Captain CI manifest under VALIDATION: PASS.
