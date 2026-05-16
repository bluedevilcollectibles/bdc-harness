# WO-STOREFRONT-SAFE-AVAILABLE-QTY-01

**WO ID:** WO-STOREFRONT-SAFE-AVAILABLE-QTY-01
**Priority:** P0
**Builder:** Codex
**Repo:** shopops-storefront
**GitHub Issue:** #121
**Status:** To Do
**Class:** CODE
**References:** wo-recipe.md, docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md

---

## 1. Objective

Replace all raw `on_hand_qty` reads in the buyer-facing storefront (catalog, PDP, category pages, search results) with calls to the Shop Ops safe availability primitive (`safe_available_qty`). Buyers must never see raw on-hand quantity as sellable. Checkout must gate on safe availability. Add an invariant test that asserts the storefront cannot expose `on_hand_qty` as the displayed or checkout-gating quantity.

**What behavior exists AFTER this WO?**
After this WO:
1. Every storefront page that previously displayed or gated on `on_hand_qty` instead calls `getSafeAvailableQty(inventoryItemId)` from the Shop Ops API.
2. The checkout flow calls `checkSafeAvailability(inventoryItemId, requestedQty)` before allowing add-to-cart.
3. No storefront module imports or references the raw `on_hand_qty` field for display or inventory-gate purposes.
4. An invariant test (`tests/test_safe_qty_invariant.js`) asserts that no storefront response contains `on_hand_qty` as the gating figure.

**Who owns this system?**
Storefront team (Builder: Codex). John Ranson is release authority.

---

## 2. Behavior Source of Truth

Primary: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 5.5 — Safe Availability.

Canonical safe availability formula from §5.5:
```
safe_available_qty = max(0, on_hand_qty - reserved_qty - channel_listed_elsewhere_qty)
```

Minimum invariant (§5.5):
```
available_qty = max(0, on_hand_qty - reserved_qty)
```

Rules from §5.5:
- Buyer-facing storefront must not expose raw `on_hand_qty` as sellable.
- Checkout must check safe availability.

**Where is the source of truth?**
The Shop Ops safe availability API (provided by WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01) is the canonical source. The storefront must consume that API; it must not compute availability itself from raw inventory fields. The architecture doc cited above is the authoritative specification.

**What existing logic is reused?**
- Existing Shop Ops API client in the storefront (`lib/shopops-client.js` or equivalent) — extend to add `getSafeAvailableQty` and `checkSafeAvailability` calls.
- Existing inventory display components in catalog/PDP pages — swap the data source, not the component structure.
- Existing checkout gating logic — replace the `on_hand_qty` field reference with the safe availability check.

---

## 3. Prior Art Check

Reviewed: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Sections 4 (inventory_items schema), 5.5 (safe availability).

The `inventory_items` table (from §4) contains both `on_hand_qty` and `available_qty`. The storefront was previously reading `on_hand_qty` (or `available_qty` without safe-availability subtraction) for display. This WO replaces those reads with the canonical safe availability endpoint.

Key existing files to audit and modify:
- Catalog page data fetcher (likely `pages/catalog.js` or `components/CatalogPage.jsx`).
- Product Detail Page (PDP) data fetcher.
- Category page and search results data fetcher.
- Checkout inventory gate.
- Shop Ops API client wrapper.

---

## 4. System Context

**Repository:** `shopops-storefront` (NOTE: this is the repository root — no `shopops-api/` subdirectory. All paths are relative to repo root.)

**Dependencies (must be deployed before this WO):**
- `WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01` — Shop Ops safe availability API endpoint (`GET /inventory/safe-available/:inventoryItemId`) must be deployed and accessible before this WO goes live.

**Runtime environment:**
- Storefront is NOT a Docker shopops-api service. Rule 19 docker exec verification does NOT apply.
- Test runner: `bun test` (or equivalent storefront test runner).
- Deploy: Standard frontend deploy pipeline for `shopops-storefront` (not shopops-api Docker).

**Affected files (storefront repo root):**
- `lib/shopops-client.js` — Shop Ops API client (add `getSafeAvailableQty`, `checkSafeAvailability`).
- Catalog data fetcher (exact file to be confirmed by reading repo at build time).
- PDP data fetcher (exact file to be confirmed by reading repo at build time).
- Category/search data fetcher (exact file to be confirmed by reading repo at build time).
- Checkout inventory gate module (exact file to be confirmed by reading repo at build time).
- `tests/test_safe_qty_invariant.js` — NEW invariant test.

---

## 5. UI Hierarchy

Per `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`:

The storefront exposes three buyer-facing inventory surfaces:
1. **Catalog / category page** — item cards show availability badge (IN STOCK / LOW / OUT OF STOCK).
2. **PDP (Product Detail Page)** — shows exact quantity available and enables/disables Add to Cart.
3. **Checkout** — final availability gate before order submission.

All three surfaces must consume `safe_available_qty`. The raw `on_hand_qty` field must not appear in any response payload that flows to buyer-facing UI as the sellable figure.

---

## 6. Mode Behavior Matrix

| Surface | Before this WO | After this WO |
|---|---|---|
| Catalog item card | Reads `on_hand_qty` from inventory API | Reads `safe_available_qty` from safe availability API |
| PDP quantity display | Reads `on_hand_qty` | Reads `safe_available_qty` |
| PDP Add to Cart gate | Checks `on_hand_qty > 0` | Checks `safe_available_qty > 0` |
| Category page item availability | Reads `on_hand_qty` | Reads `safe_available_qty` |
| Search results availability badge | Reads `on_hand_qty` | Reads `safe_available_qty` |
| Checkout final gate | May read `on_hand_qty` | Calls `checkSafeAvailability(inventoryItemId, qty)` |
| `safe_available_qty` = 0, `on_hand_qty` > 0 | Shows as IN STOCK (BUG) | Shows as OUT OF STOCK (CORRECT) |

**What MUST NEVER break? (invariants)**
- `safe_available_qty` must be `max(0, on_hand_qty - reserved_qty - channel_listed_elsewhere_qty)`.
- No storefront response, page render, or checkout call may use raw `on_hand_qty` as the sellable figure.
- Checkout must gate on safe availability; if `safe_available_qty < requestedQty`, checkout must be blocked.
- The invariant test must assert that storefront catalog/PDP responses do not expose `on_hand_qty` as the gating field.

**What happens if it runs twice? (idempotency)**
The code changes are idempotent — replacing a data source reference is a pure substitution. Running the implementation twice on the same codebase results in the same final state.

---

## 7. Backend Function Inventory

| Function | File | Status |
|---|---|---|
| `getSafeAvailableQty(inventoryItemId)` | `lib/shopops-client.js` | NEW |
| `checkSafeAvailability(inventoryItemId, requestedQty)` | `lib/shopops-client.js` | NEW |
| Catalog data fetcher — replace `on_hand_qty` with safe qty call | `pages/catalog.js` (or equivalent) | EXISTING (modify) |
| PDP data fetcher — replace `on_hand_qty` with safe qty call | `pages/pdp.js` (or equivalent) | EXISTING (modify) |
| Category/search data fetcher — replace `on_hand_qty` | `pages/category.js` (or equivalent) | EXISTING (modify) |
| Checkout inventory gate — replace `on_hand_qty` check | `lib/checkout.js` (or equivalent) | EXISTING (modify) |
| Invariant test suite | `tests/test_safe_qty_invariant.js` | NEW |

Note: Exact file names must be confirmed by reading the repo at build time. The function labels above will be updated to `EXISTING (file:line)` format in the implementation commit.

---

## 8. Data Flow

```
[Browser: Catalog page load]
    → Storefront data fetcher calls getSafeAvailableQty(inventoryItemId)
        → GET /inventory/safe-available/:inventoryItemId (Shop Ops API)
        → Returns { safe_available_qty: N, reserved_qty: R, on_hand_qty: H }
    → Catalog component renders availability badge based on safe_available_qty
    → on_hand_qty is NOT used for display or gating

[Browser: Checkout]
    → Checkout gate calls checkSafeAvailability(inventoryItemId, requestedQty)
        → GET /inventory/safe-available/:inventoryItemId
        → safe_available_qty < requestedQty → block checkout, show "Not enough stock"
        → safe_available_qty >= requestedQty → allow checkout
```

**Grep assertions (Check 8A):**
The following strings MUST appear (or be absent) in the deployed source after this WO:

```bash
# Must exist in client wrapper
grep -rn "getSafeAvailableQty" lib/shopops-client.js
grep -rn "checkSafeAvailability" lib/shopops-client.js
grep -rn "safe-available" lib/shopops-client.js

# Must exist in test
grep -rn "on_hand_qty" tests/test_safe_qty_invariant.js
grep -rn "safe_available_qty" tests/test_safe_qty_invariant.js

# Must NOT appear as gating field in catalog/PDP fetchers (after removal)
# This is verified by the invariant test, not by grep absence alone
```

**How does CI prove it works?**
The invariant test (`tests/test_safe_qty_invariant.js`) mocks the Shop Ops API to return a scenario where `on_hand_qty = 5` and `safe_available_qty = 0` (all reserved). It then asserts:
1. Catalog page renders item as OUT OF STOCK.
2. PDP Add to Cart button is disabled.
3. Checkout gate rejects the request.
If any assertion fails, `on_hand_qty` is still leaking as the gating figure.

---

## 9. Database Schema References

**`inventory_items` table** — consumed read-only by the storefront via the Shop Ops API; not accessed directly by the storefront. Per `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 4:

| Column | Type | Notes |
|---|---|---|
| `tenant_id` | UUID | |
| `inventory_item_id` | UUID PK | |
| `issue_id` | UUID | FK to issues |
| `on_hand_qty` | INTEGER | Raw stock count — MUST NOT be exposed directly to storefront as sellable |
| `reserved_qty` | INTEGER | Sum of RESERVED allocations |
| `available_qty` | INTEGER | Computed: max(0, on_hand_qty - reserved_qty) |
| `cost` | NUMERIC | |
| `price` | NUMERIC | |
| `source` | TEXT | |
| `received_at` | TIMESTAMPTZ | |

Schema claim: column names above are from the architecture spec (§4). The storefront does not access this table directly; it consumes the safe availability API response. Actual DB schema must be verified by the Shop Ops API team against: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'inventory_items' AND table_schema = 'public' ORDER BY ordinal_position;`

The `safe_available_qty` returned by the API is:
```
max(0, on_hand_qty - reserved_qty - channel_listed_elsewhere_qty)
```
This field is computed server-side and is not a stored column.

---

## 10. Deploy Target

- **Repo:** `bluedevilcollectibles/shopops-storefront`
- **Branch:** `wo/storefront-safe-available-qty-01`
- **Base branch:** `main`
- **PR:** Closes #121
- **Runtime:** Storefront deploy pipeline (not Docker shopops-api). Rule 19 docker exec does NOT apply.
- **Test runner:** `bun test tests/test_safe_qty_invariant.js`
- **Pre-deploy dependency:** WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01 must be deployed to the Shop Ops API before the storefront goes live against production.

---

## 11. Test Scenarios

**Test 1 — Catalog OUT OF STOCK when safe_available_qty = 0 despite on_hand_qty > 0**
- Given: Shop Ops safe availability API returns `{ safe_available_qty: 0, on_hand_qty: 5 }` for item X (all units reserved).
- When: The storefront catalog page loads and fetches availability for item X.
- Then: Item X renders as OUT OF STOCK (availability badge shows "Out of Stock" or equivalent). The raw `on_hand_qty` of 5 is not shown as available.

**Test 2 — PDP Add to Cart disabled when safe_available_qty = 0**
- Given: Shop Ops safe availability API returns `{ safe_available_qty: 0, on_hand_qty: 3 }` for item Y.
- When: The PDP for item Y is rendered.
- Then: The Add to Cart button is disabled or hidden. The quantity selector shows 0 available. Raw `on_hand_qty` is not used as the enable/disable gate.

**Test 3 — Checkout blocked when safe_available_qty < requestedQty**
- Given: Safe availability returns `{ safe_available_qty: 1 }` for item Z. Buyer attempts to add 2 units.
- When: `checkSafeAvailability(itemZ, 2)` is called at checkout.
- Then: Checkout is blocked. An error message is shown ("Only 1 available"). The order is not submitted.

**Test 4 — Checkout allowed when safe_available_qty >= requestedQty**
- Given: Safe availability returns `{ safe_available_qty: 5 }` for item W. Buyer adds 2 units.
- When: `checkSafeAvailability(itemW, 2)` is called at checkout.
- Then: Checkout proceeds. No error is shown. The order is submitted.

**Test 5 — Invariant: no raw on_hand_qty exposed as sellable in catalog response**
- Given: The catalog page fetches availability for a list of items.
- When: The response payload for any item is inspected.
- Then: The quantity used for availability gating (IN STOCK / OUT OF STOCK determination) equals `safe_available_qty`, not `on_hand_qty`. The test asserts `displayedQty !== on_hand_qty` when they differ.

---

## 12. Stop Point

All of the following must pass before marking REVIEW:

```bash
# 1. Grep assertions pass
grep -rn "getSafeAvailableQty" lib/shopops-client.js
grep -rn "checkSafeAvailability" lib/shopops-client.js
grep -rn "safe-available" lib/shopops-client.js

# 2. Test suite passes
bun test tests/test_safe_qty_invariant.js
# Expected: >= 5 tests, 0 failures

# 3. No raw on_hand_qty as gating in catalog/PDP fetchers
# (verified by passing Test 1 and Test 5 above)

# 4. PR opened
gh pr view --repo bluedevilcollectibles/shopops-storefront
# Expected: PR exists targeting main, "Closes #121" in body
```

**Given/When/Then CI gate:**
- Given: `getSafeAvailableQty` and `checkSafeAvailability` are present in `lib/shopops-client.js`.
- When: `bun test tests/test_safe_qty_invariant.js` runs.
- Then: All tests pass (0 failures), catalog/PDP/checkout all gate on `safe_available_qty`, and PR is open against main with Closes #121.
