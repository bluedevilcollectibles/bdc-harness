# WO-MGMT-UI-PULL-LIST-VIEWS-01 — Cheers CRM Management UI Pull-List Views

**WO ID:** WO-MGMT-UI-PULL-LIST-VIEWS-01
**Priority:** P0
**Builder:** Codex
**Repo:** lspro-react
**GitHub Issue:** #126
**Status:** To Do
**Created:** 2026-05-16
**Reference:** wo-recipe.md (12-section format)

---

## 1. Objective

Build the staff-facing Cheers CRM / Management UI views that display canonical pull-list state
for every customer. Staff must be able to search customers, view channel identities, inspect
subscription and pull-list status, see allocation state, browse invoices and fulfillment status,
and view inventory reservation data — all with raw quantity, reserved quantity, and safe
availability shown as distinctly labeled fields.

Deliver:
1. `CustomerSearchPage` — full-text + phone/email search over canonical `customers` table.
2. `CustomerProfileDrawer` — slide-in panel (or page) showing a customer's complete pull-list
   profile. Contains: channel identity list, pull-list subscriptions, allocation status table,
   invoice / statement history, fulfillment status, inventory reservation summary.
3. `PullListPanel` — subscription rows with title, issue, status (subscribed / paused /
   cancelled), and allocation state.
4. `AllocationStatusTable` — per-allocation rows: `allocation_id`, `inventory_item_id`,
   `quantity`, `status`, `allocated_at`, `fulfilled_at`, `invoiced_at`.
5. `InventoryReservationSummary` — three labeled quantities per item: Raw On-Hand, Reserved,
   Safe Available. Labels must match these exact strings.
6. `ChannelIdentityView` — list of `customer_identity_bindings` rows for the customer with
   source, external_id, and edit control for WhatNot username.

All edits go through canonical Shop Ops API calls — the UI never writes directly to Supabase.

**What behavior exists AFTER this WO?**
After this WO, staff can look up any customer in the Cheers CRM UI, see their complete pull-list
state including allocation status and inventory reservations, and edit WhatNot username and
contact information through canonical API routes. Raw, reserved, and safe quantities are always
shown as three distinct labeled fields — never a single unlabeled number.

---

## 2. Behavior Source of Truth

Primary plan document:
`docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Section 7 (Management UI).

All required views, field labels, edit controls, and data sources in this WO derive exclusively
from that plan document. No field names are invented.

Secondary references:
- `wo-recipe.md` — 12-section WO template (authoring compliance)
- `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 7 (canonical spec
  for management UI requirements)

**Where is the source of truth?**
The plan document at `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Section 7 is authoritative for which views must exist and what data each must display. The
`lspro-react` codebase and Shop Ops API OpenAPI spec are ground truth for existing components and
available API routes.

---

## 3. Prior Art Check

**Plan document consulted:** `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Section 7 (Management UI).

Builder MUST run the following before creating any new component:

```bash
# Check for existing customer search or profile components
find lspro-react/src/components -name "*Customer*" -o -name "*customer*" 2>/dev/null
find lspro-react/src/components -name "*PullList*" -o -name "*pull-list*" 2>/dev/null
find lspro-react/src/routes -name "*Customer*" -o -name "*customer*" 2>/dev/null

# Check existing API client methods for customer / pull-list endpoints
grep -rn "customer\|pullList\|pull_list\|allocation" lspro-react/src/lib/ \
  --include="*.ts" --include="*.tsx" | head -30
```

Also consult the `BDC-Component-Library` skill before creating any new component to avoid
duplicating existing UI elements.

---

## 4. System Context

**Owner:** Blue Devil Collectibles (BDC) engineering team — Major Build executes, General
approves architecture.

**Repo:** `bluedevilcollectibles/lspro-react` (React + TypeScript, Vite, Tailwind v4, shadcn/ui,
Zustand). This is NOT shopops-api. There is no `shopops-api/` path prefix and no Docker
container runtime verify (Rule 19) for this repo.

**Dependencies this WO requires (must be REVIEW or DONE before this WO starts):**
- `WO-SHOPOPS-PULL-LIST-ALLOCATION-ENGINE-01` — allocation table and API routes must exist
  so `AllocationStatusTable` has data to display
- `WO-SHOPOPS-CUSTOMER-IDENTITY-BINDING-01` (#112) — `customer_identity_bindings` table and
  API routes must exist so `ChannelIdentityView` has data
- `WO-SHOPOPS-PULL-LIST-FULFILLMENT-HANDOFF-01` — fulfillment status API must exist so
  fulfillment rows can be shown
- Shop Ops API endpoints for customer search, identity bindings, allocation, and fulfillment
  must be available in staging
- GitHub CLI (`gh`) authenticated to `bluedevilcollectibles` org

**Adjacent WOs in the same sprint:**
- WO-SHOPOPS-PULL-LIST-OVERSELL-INVARIANT-TESTS-01 (#127) — tests that the UI never exposes
  `on_hand_qty` directly; this WO provides the UI to test against

**Who owns this system?**
Blue Devil Collectibles. John Ranson is the sole release authority. General (ChatGPT) owns
architecture decisions. Major Build (Claude Code / Codex) owns execution.

**What MUST NEVER break? (invariants)**
1. The UI MUST NEVER show `on_hand_qty` without the "Raw On-Hand" label — it must always be
   accompanied by the "Reserved" and "Safe Available" labels in the same component.
2. Staff edits (WhatNot username, email, phone) MUST go through canonical Shop Ops API calls
   (never direct Supabase writes from the frontend).
3. The `InventoryReservationSummary` MUST display all three quantities: "Raw On-Hand",
   "Reserved", "Safe Available" — all three labels are mandatory, not optional.
4. Customer identity bindings MUST show source enum values exactly as returned by the API
   (STOREFRONT, POS, SHOPIFY, WHATNOT, EBAY, WOOCOMMERCE, TIKTOK, LOCG, MANUAL).
5. TypeScript strict mode must be satisfied — no `any` types without explicit justification.

---

## 5. UI Hierarchy

```
/crm/customers                          ← CustomerSearchPage (route)
  |
  +-- CustomerSearchBar                 ← input: text, phone, email; calls GET /api/customers?q=
  +-- CustomerSearchResults             ← table of matching customers (name, email, phone, source)
        |
        +-- [row click] → CustomerProfileDrawer (slide-in panel or /crm/customers/:id)
              |
              +-- CustomerProfileHeader (name, email, phone, status badge)
              |
              +-- ChannelIdentityView   ← GET /api/customers/:id/identities
              |     +-- IdentityRow (source badge, external_id, last_seen)
              |     +-- WhatNotUsernameEdit (inline edit → PATCH /api/customers/:id/whatnot)
              |
              +-- PullListPanel         ← GET /api/customers/:id/pull-lists
              |     +-- SubscriptionRow (title, issue, status: subscribed|paused|cancelled)
              |     +-- AllocationStatusTable ← GET /api/customers/:id/allocations
              |           +-- AllocationRow (allocation_id, item, qty, status, allocated_at,
              |                             fulfilled_at, invoiced_at)
              |
              +-- InvoiceStatementPanel ← GET /api/customers/:id/invoices
              |     +-- InvoiceRow (invoice_id, date, amount, status: paid|unpaid|overdue)
              |
              +-- FulfillmentStatusPanel ← GET /api/customers/:id/fulfillments
              |     +-- FulfillmentRow (order_id, item, status: pending|shipped|delivered)
              |
              +-- InventoryReservationSummary ← GET /api/customers/:id/reservations
                    +-- ReservationRow (item_title, raw_on_hand, reserved, safe_available)
                    |     (labels: "Raw On-Hand" | "Reserved" | "Safe Available")
                    +-- note: quantities shown as three distinct labeled fields per item
```

Reference: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 7,
"Management UI Required Views."

All components live under `lspro-react/src/components/crm/`. Route pages live under
`lspro-react/src/routes/crm/`.

---

## 6. Mode Behavior Matrix

| UI Action | Component | API Call | Outcome |
|---|---|---|---|
| Staff searches customer by name/email/phone | CustomerSearchBar → CustomerSearchResults | GET /api/customers?q= | List of matching customers |
| Staff clicks customer row | CustomerSearchResults row | — (navigation) | CustomerProfileDrawer opens |
| Staff views channel identities | ChannelIdentityView | GET /api/customers/:id/identities | List of bindings with source + external_id |
| Staff edits WhatNot username | WhatNotUsernameEdit | PATCH /api/customers/:id/whatnot | Username updated via API |
| Staff edits email | CustomerProfileHeader (edit mode) | PATCH /api/customers/:id | Email updated via API |
| Staff views pull-list subscriptions | PullListPanel | GET /api/customers/:id/pull-lists | Subscription rows with allocation state |
| Staff views allocation status | AllocationStatusTable | GET /api/customers/:id/allocations | Allocation rows |
| Staff views invoices | InvoiceStatementPanel | GET /api/customers/:id/invoices | Invoice rows |
| Staff views fulfillment | FulfillmentStatusPanel | GET /api/customers/:id/fulfillments | Fulfillment rows |
| Staff views inventory reservations | InventoryReservationSummary | GET /api/customers/:id/reservations | Three labeled quantities per item |

**What happens if it runs twice? (idempotency)**
Component file creation is idempotent — if the component already exists from a prior run, the
builder reads the existing file and patches rather than creating a duplicate. API calls from the
UI are idempotent reads (GETs) or upsert-style PATCHes. Running the UI build twice produces the
same compiled output.

---

## 7. Backend Function Inventory

This WO creates React components and API client calls; it does NOT add routes to the Shop Ops
API (those are in dependency WOs). All items are frontend.

| Item | File | Status | Notes |
|---|---|---|---|
| `CustomerSearchPage` | `src/routes/crm/CustomerSearchPage.tsx` | NEW | Route page, search bar + results |
| `CustomerSearchBar` | `src/components/crm/CustomerSearchBar.tsx` | NEW | Text input, triggers GET /api/customers?q= |
| `CustomerSearchResults` | `src/components/crm/CustomerSearchResults.tsx` | NEW | Table of results, row click opens drawer |
| `CustomerProfileDrawer` | `src/components/crm/CustomerProfileDrawer.tsx` | NEW | Slide-in panel with all sub-panels |
| `CustomerProfileHeader` | `src/components/crm/CustomerProfileHeader.tsx` | NEW | Name, email, phone, status, edit controls |
| `ChannelIdentityView` | `src/components/crm/ChannelIdentityView.tsx` | NEW | Identity bindings list + WhatNot edit |
| `WhatNotUsernameEdit` | `src/components/crm/WhatNotUsernameEdit.tsx` | NEW | Inline edit → PATCH /api/customers/:id/whatnot |
| `PullListPanel` | `src/components/crm/PullListPanel.tsx` | NEW | Subscription rows |
| `AllocationStatusTable` | `src/components/crm/AllocationStatusTable.tsx` | NEW | Allocation rows with all six fields |
| `InvoiceStatementPanel` | `src/components/crm/InvoiceStatementPanel.tsx` | NEW | Invoice rows |
| `FulfillmentStatusPanel` | `src/components/crm/FulfillmentStatusPanel.tsx` | NEW | Fulfillment rows |
| `InventoryReservationSummary` | `src/components/crm/InventoryReservationSummary.tsx` | NEW | Three labeled quantities per item |
| CRM API client methods | `src/lib/api/crm.ts` | NEW | Typed wrappers for all CRM GET/PATCH calls |
| CRM route registration | `src/App.tsx` or router file | EXISTING (builder MUST find exact file:line) | Add `/crm/customers` route |

---

## 8. Data Flow

```
Staff navigates to /crm/customers
  |
  v
CustomerSearchPage renders CustomerSearchBar
  |
  Staff types query
  |
  v
GET /api/customers?q={query}
  --> response: [{ customer_id, display_name, email, phone, status }]
  |
  v
CustomerSearchResults renders rows
  |
  Staff clicks a row
  |
  v
CustomerProfileDrawer opens for customer_id
  |
  +-- GET /api/customers/:id/identities      → ChannelIdentityView
  +-- GET /api/customers/:id/pull-lists      → PullListPanel
  +-- GET /api/customers/:id/allocations     → AllocationStatusTable
  +-- GET /api/customers/:id/invoices        → InvoiceStatementPanel
  +-- GET /api/customers/:id/fulfillments    → FulfillmentStatusPanel
  +-- GET /api/customers/:id/reservations    → InventoryReservationSummary
  |     (returns: [{ item_title, on_hand_qty, reserved_qty, safe_available_qty }])
  |     (rendered as: "Raw On-Hand: X | Reserved: Y | Safe Available: Z")
  |
  Staff edits WhatNot username
  |
  v
PATCH /api/customers/:id/whatnot { whatnot_username }
  --> response: 200 { customer_id, whatnot_username }
  --> ChannelIdentityView re-fetches to reflect updated binding
```

**Cross-repo note (bdc-xo):** The spec document lives in `bluedevilcollectibles/bdc-xo`. The
implementation lives in `bluedevilcollectibles/lspro-react`. The YAML workflow fetches the spec
from `bdc-xo` at runtime via `gh api`.

### Grep Assertions (Check 8A)

The following greps MUST pass in the `lspro-react` directory after implementation:

```bash
grep -r "CustomerSearchPage" lspro-react/src/ | grep -q "." \
  || (echo "FAIL: CustomerSearchPage not found" && exit 1)

grep -r "CustomerProfileDrawer" lspro-react/src/ | grep -q "." \
  || (echo "FAIL: CustomerProfileDrawer not found" && exit 1)

grep -r "InventoryReservationSummary" lspro-react/src/ | grep -q "." \
  || (echo "FAIL: InventoryReservationSummary not found" && exit 1)

grep -r "Raw On-Hand" lspro-react/src/ | grep -q "." \
  || (echo "FAIL: 'Raw On-Hand' label not found — invariant violation" && exit 1)

grep -r "Safe Available" lspro-react/src/ | grep -q "." \
  || (echo "FAIL: 'Safe Available' label not found — invariant violation" && exit 1)

grep -r "AllocationStatusTable" lspro-react/src/ | grep -q "." \
  || (echo "FAIL: AllocationStatusTable not found" && exit 1)

grep -r "ChannelIdentityView" lspro-react/src/ | grep -q "." \
  || (echo "FAIL: ChannelIdentityView not found" && exit 1)

grep -r "WhatNotUsernameEdit" lspro-react/src/ | grep -q "." \
  || (echo "FAIL: WhatNotUsernameEdit not found" && exit 1)
```

---

## 9. Database Schema References

This WO reads data through Shop Ops API routes — it does not query Supabase directly. The
following tables are read (not modified) via API responses. Builder MUST verify column names
against staging before asserting field names in API response types:

```sql
-- customers table (from WO-SHOPOPS-CUSTOMER-IDENTITY-BINDING-01)
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'customers'
ORDER BY ordinal_position;

-- customer_identity_bindings table (from WO-SHOPOPS-CUSTOMER-IDENTITY-BINDING-01)
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'customer_identity_bindings'
ORDER BY ordinal_position;

-- allocations table (from WO-SHOPOPS-PULL-LIST-ALLOCATION-ENGINE-01)
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'allocations'
ORDER BY ordinal_position;
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

Column claims above come directly from plan doc Section 4. Builder MUST run the
`information_schema` queries above against staging before writing TypeScript API response types.

---

## 10. Deploy Target

- **Platform:** `lspro-react` (React + TypeScript, Vite build, deployed via GitHub Actions)
- **Environment:** Staging (auto-deploy from branch push per LSPRO React deploy pipeline)
- **No Docker container** — this is a React frontend; no `docker exec` Rule 19 applies
- **Build validation:**
  ```bash
  cd lspro-react && bun run build
  # Must exit 0 with no TypeScript errors
  ```
- **No production deploy** without John's explicit "PROCEED DEPLOY."

---

## 11. Test Scenarios

Tests live in `lspro-react/src/components/crm/` (co-located) or `lspro-react/tests/crm/`.
Component tests use React Testing Library (or equivalent). All tests run against mocked API
responses (no real Supabase calls from frontend tests).

**Test 1 — Customer search returns results**

Given: Shop Ops API returns `[{ customer_id: 'cust-1', display_name: 'Alice Smith', email: 'alice@example.com' }]`
  for `GET /api/customers?q=alice`
When: staff types "alice" in the CustomerSearchBar
Then:
- CustomerSearchResults renders one row containing "Alice Smith"
- Row contains "alice@example.com"
- Assert: `screen.getByText('Alice Smith')` does not throw

**Test 2 — InventoryReservationSummary shows all three labels**

Given: API returns `[{ item_title: 'Amazing Spider-Man #1', on_hand_qty: 10, reserved_qty: 7, safe_available_qty: 3 }]`
When: InventoryReservationSummary renders with that data
Then:
- Text "Raw On-Hand" is present in the rendered output
- Text "Reserved" is present in the rendered output
- Text "Safe Available" is present in the rendered output
- The values 10, 7, and 3 are each visible and associated with their respective labels
- Assert: `screen.getByText(/Raw On-Hand/)` does not throw
- Assert: `screen.getByText(/Safe Available/)` does not throw

**Test 3 — WhatNot username edit calls PATCH API**

Given: ChannelIdentityView renders with a WHATNOT binding; WhatNotUsernameEdit is visible
When: staff types "newuser123" in the WhatNot username input and submits
Then:
- `PATCH /api/customers/:id/whatnot` is called with body `{ whatnot_username: 'newuser123' }`
- ChannelIdentityView reflects the updated username after the PATCH response
- Assert: mock PATCH handler was called exactly once with correct body

**Test 4 — AllocationStatusTable renders all required columns**

Given: API returns one allocation row with all fields populated
When: AllocationStatusTable renders that row
Then:
- Columns rendered: allocation_id, item, qty, status, allocated_at, fulfilled_at, invoiced_at
- Each column header is visible
- Assert: `screen.getByText(/allocated_at|Allocated At/)` does not throw

**How does CI prove it works?**
```bash
cd lspro-react && bun test src/components/crm/
```
All 4 tests must pass. GitHub Actions runs this suite on every PR to `lspro-react/main`.

---

## 12. Stop Point

WO is REVIEW-eligible when ALL of the following CI-executable commands return 0:

**Stop 1 — TypeScript build passes**
```bash
cd lspro-react && bun run type-check
# Exit code 0 (no TypeScript errors)
```

**Stop 2 — All component tests pass**
```bash
cd lspro-react && bun test src/components/crm/
# Exit code 0 and output contains "4 pass" (or more if builder added additional tests)
```

**Stop 3 — Grep assertions pass**
```bash
grep -r "Raw On-Hand" lspro-react/src/ | grep -q "." \
  && echo "PASS" || (echo "FAIL: Raw On-Hand label missing" && exit 1)
grep -r "Safe Available" lspro-react/src/ | grep -q "." \
  && echo "PASS" || (echo "FAIL: Safe Available label missing" && exit 1)
grep -r "CustomerProfileDrawer" lspro-react/src/ | grep -q "." \
  && echo "PASS" || (echo "FAIL: CustomerProfileDrawer missing" && exit 1)
grep -r "InventoryReservationSummary" lspro-react/src/ | grep -q "." \
  && echo "PASS" || (echo "FAIL: InventoryReservationSummary missing" && exit 1)
```

**Stop 4 — Vite build succeeds**
```bash
cd lspro-react && bun run build
# Exit code 0 with no errors
```

**Stop 5 — PR opened against lspro-react/main**

Given: all stops 1–4 pass
When: `gh pr view --repo bluedevilcollectibles/lspro-react --json state` is run
Then: output contains `"state":"OPEN"` and PR title includes
  `WO-MGMT-UI-PULL-LIST-VIEWS-01` and PR body contains `Closes #126`

All 5 stops must be included in the Captain CI manifest under VALIDATION: PASS.
