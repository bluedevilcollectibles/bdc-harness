# WO-SHOPOPS-BILLING-ALLOCATION-SOURCE-OF-TRUTH-01

**WO ID:** WO-SHOPOPS-BILLING-ALLOCATION-SOURCE-OF-TRUTH-01
**Priority:** P0
**Builder:** Codex
**Repo:** shopops-api
**GitHub Issue:** #119
**Status:** To Do
**Class:** CODE
**References:** wo-recipe.md, docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md

---

## 1. Objective

Enforce billing source-of-truth in the Shop Ops pull-list engine. Every invoice line and statement line MUST reference either an allocation row, a fulfillment row, or a deterministic bridge between them. Charges originating directly from raw `customer_pulls` rows — without a resolved allocation — are forbidden. Stripe payments that arrive without a matching Shop Ops order, invoice, or customer reference must be rejected at the reconciliation boundary, not silently accepted.

**What behavior exists AFTER this WO?**
After this WO, the billing pipeline enforces three hard rules at the API layer:
1. `createInvoiceLine` and `createStatementLine` reject any call that cannot resolve an `allocation_id` or a `fulfillment_row_id`.
2. `reconcileStripePayment` rejects any Stripe charge that lacks a `shopops_order_id`, `shopops_invoice_id`, or `shopops_customer_id` reference.
3. Attempts to bill directly from `customer_pulls` without allocation linkage return HTTP 422 with error code `BILLING_NO_ALLOCATION_LINKAGE`.

**Who owns this system?**
Shop Ops API team (Builder: Codex). John Ranson is release authority.

---

## 2. Behavior Source of Truth

Primary: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 5.6 — Billing.

Canonical billing rules from §5.6:
1. Pull demand is not billable by itself.
2. Allocations reserve inventory.
3. Fulfillment / ready-to-invoice state makes allocation billable.
4. Invoice/statement lines must reference allocations, fulfillment rows, or a deterministic bridge.
5. Payments reconcile to Shop Ops order / invoice / customer.

**Forbidden (§5.6 invariants):**
- Charging from raw `customer_pulls` without allocation linkage.
- Orphaned Stripe payments with no Shop Ops order/invoice/customer reference.
- Channel-local payment state becoming canonical.

**Where is the source of truth?**
The `allocations` table is the canonical billing anchor. Any billing action must trace back to a row in `allocations` with status `READY_TO_INVOICE` or later. The architecture doc cited above is the authoritative specification.

---

## 3. Prior Art Check

Reviewed: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Sections 4 (data model), 5.5, 5.6, 5.7.

Existing patterns in shopops-api to reuse:
- `services/billing.js` — existing billing service (extend, do not replace).
- `services/stripe.js` — existing Stripe wrapper (extend `reconcilePayment`).
- `middleware/validate.js` — existing request validation middleware pattern.
- `db/allocations.js` — allocation read/write helpers (add `getAllocationByPullId`).

**What existing logic is reused?**
- The allocation lifecycle state machine (`RESERVED → READY_TO_INVOICE → INVOICED → SHIPPED → PICKED_UP → RELEASED → CANCELLED`) defined in §4 is already partially implemented by WO-SHOPOPS-PULL-LIST-ALLOCATION-ENGINE-01. This WO adds enforcement at the billing boundary on top of that foundation.
- Stripe payment webhook parsing in `services/stripe.js` is reused; only the rejection guard is added.

---

## 4. System Context

**Repository:** `shopops-api` (Node.js, ES modules, deployed as Docker container `shopops-api`)

**Dependencies (must be deployed before this WO):**
- `WO-SHOPOPS-PULL-LIST-ALLOCATION-ENGINE-01` — allocation table and lifecycle state machine must exist.
- `WO-SHOPOPS-PULL-LIST-CUSTOMER-PULL-MODEL-01` — `customer_pulls` table and pull demand model must be in place.

**Runtime environment:**
- Docker container: `shopops-api`
- Source path inside container: `/app/`
- No source mount — image must be rebuilt and restarted for changes to take effect (Rule 19).

**Affected services:**
- `services/billing.js` — invoice/statement line creation.
- `services/stripe.js` — Stripe payment reconciliation.
- `routes/billing.js` — API routes (`POST /billing/invoice-lines`, `POST /billing/statement-lines`).
- `db/allocations.js` — allocation lookup helpers.
- `middleware/validate.js` — shared validation middleware.

---

## 5. UI Hierarchy

Per `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`:

This WO is backend-only. No new UI surfaces are introduced. The billing enforcement is invisible to end users when valid; it surfaces as API error responses (`422 BILLING_NO_ALLOCATION_LINKAGE`, `422 BILLING_ORPHANED_STRIPE_PAYMENT`) when invariants are violated. Management UI visibility of invoice/statement lines is handled by the existing billing dashboard (not modified here).

---

## 6. Mode Behavior Matrix

| Input state | Outcome |
|---|---|
| Invoice line with valid `allocation_id`, status `READY_TO_INVOICE` | Accepted — line created |
| Invoice line with valid `fulfillment_row_id` (bridge to allocation) | Accepted — line created |
| Invoice line from raw `customer_pulls` (no allocation link) | Rejected — HTTP 422, `BILLING_NO_ALLOCATION_LINKAGE` |
| Stripe payment with `shopops_order_id` present | Accepted — reconciled |
| Stripe payment with `shopops_invoice_id` present (no order) | Accepted — reconciled |
| Stripe payment with `shopops_customer_id` only | Accepted — reconciled at customer level |
| Stripe payment with none of order/invoice/customer | Rejected — HTTP 422, `BILLING_ORPHANED_STRIPE_PAYMENT` |
| Statement line with allocation in status `INVOICED` or later | Accepted |
| Statement line with allocation in status `RESERVED` (not yet billable) | Rejected — HTTP 422, `BILLING_NOT_READY_TO_INVOICE` |

**What MUST NEVER break? (invariants)**
- No invoice line may exist in the database without a traceable `allocation_id`.
- No Stripe payment may be reconciled without a Shop Ops anchor (order, invoice, or customer).
- Allocation lifecycle transitions (`RESERVED → READY_TO_INVOICE`) must not be bypassed by billing calls.
- Idempotency: creating the same invoice line twice (same `allocation_id` + idempotency key) must not create duplicate rows; the second call returns the existing line.

**What happens if it runs twice? (idempotency)**
All write operations check for an existing record by `(allocation_id, idempotency_key)` unique constraint before inserting. If the record exists, the existing row is returned with HTTP 200. No duplicate lines are created.

---

## 7. Backend Function Inventory

| Function | File | Status |
|---|---|---|
| `validateBillingAllocation(allocationId)` | `services/billing.js` | NEW |
| `validateBillingFulfillmentBridge(fulfillmentRowId)` | `services/billing.js` | NEW |
| `createInvoiceLine(params)` | `services/billing.js` | NEW |
| `createStatementLine(params)` | `services/billing.js` | NEW |
| `reconcileStripePayment(stripeCharge)` | `services/stripe.js` | NEW (guard added to existing skeleton) |
| `getAllocationByPullId(pullId)` | `db/allocations.js` | NEW |
| `getAllocationById(allocationId)` | `db/allocations.js` | NEW |
| `upsertInvoiceLine(params)` | `db/billing.js` | NEW |
| `upsertStatementLine(params)` | `db/billing.js` | NEW |
| `POST /billing/invoice-lines` route handler | `routes/billing.js` | NEW |
| `POST /billing/statement-lines` route handler | `routes/billing.js` | NEW |
| `validateBillingRequest` middleware | `middleware/validate.js` | NEW |

---

## 8. Data Flow

```
[API caller] → POST /billing/invoice-lines
    → validateBillingRequest middleware (checks body shape)
    → createInvoiceLine(params)
        → validateBillingAllocation(allocationId)
            → getAllocationById(allocationId)
            → check status in {READY_TO_INVOICE, INVOICED, SHIPPED, PICKED_UP}
            → FAIL → throw BillingError('BILLING_NO_ALLOCATION_LINKAGE')
        → upsertInvoiceLine (idempotency check by allocation_id + idempotency_key)
        → return invoice line row
    → HTTP 201 (created) or 200 (idempotent return)

[Stripe webhook] → POST /webhooks/stripe
    → reconcileStripePayment(stripeCharge)
        → check shopops_order_id OR shopops_invoice_id OR shopops_customer_id
        → NONE present → throw BillingError('BILLING_ORPHANED_STRIPE_PAYMENT')
        → record reconciliation row
```

**Grep assertions (Check 8A):**
The following strings MUST appear in the deployed source after this WO:

```bash
grep -rn "BILLING_NO_ALLOCATION_LINKAGE" /app/services/billing.js
grep -rn "BILLING_ORPHANED_STRIPE_PAYMENT" /app/services/stripe.js
grep -rn "validateBillingAllocation" /app/services/billing.js
grep -rn "READY_TO_INVOICE" /app/services/billing.js
grep -rn "createInvoiceLine" /app/routes/billing.js
grep -rn "createStatementLine" /app/routes/billing.js
grep -rn "getAllocationById" /app/db/allocations.js
```

**How does CI prove it works?**
The test suite (`tests/test_billing_allocation.js`) runs against staging Supabase with real allocation fixtures. Tests assert:
1. Valid allocation → invoice line created (HTTP 201).
2. Missing allocation → HTTP 422 with code `BILLING_NO_ALLOCATION_LINKAGE`.
3. Orphaned Stripe charge → HTTP 422 with code `BILLING_ORPHANED_STRIPE_PAYMENT`.
4. Duplicate call → HTTP 200 (idempotent, same row returned).

---

## 9. Database Schema References

**`allocations` table** — verified against migration file `migrations/004_allocations.sql` (to be created by WO-SHOPOPS-PULL-LIST-ALLOCATION-ENGINE-01):

| Column | Type | Notes |
|---|---|---|
| `tenant_id` | UUID | FK to tenants |
| `allocation_id` | UUID PK | |
| `pull_id` | UUID | FK to customer_pulls |
| `customer_id` | UUID | FK to customers |
| `inventory_item_id` | UUID | FK to inventory_items |
| `quantity` | INTEGER | |
| `status` | TEXT | RESERVED, READY_TO_INVOICE, INVOICED, SHIPPED, PICKED_UP, RELEASED, CANCELLED |
| `allocated_at` | TIMESTAMPTZ | |
| `fulfilled_at` | TIMESTAMPTZ | nullable |
| `invoiced_at` | TIMESTAMPTZ | nullable |

Schema claim verification: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'allocations' AND table_schema = 'public' ORDER BY ordinal_position;` — must be run against staging Supabase before building to confirm dependency WO has landed.

**`invoice_lines` table** — NEW, created by migration `migrations/006_invoice_lines.sql`:

| Column | Type | Notes |
|---|---|---|
| `tenant_id` | UUID | |
| `invoice_line_id` | UUID PK | |
| `allocation_id` | UUID | FK to allocations, NOT NULL |
| `fulfillment_row_id` | UUID | nullable FK to fulfillment_rows |
| `amount_cents` | INTEGER | |
| `currency` | TEXT | |
| `idempotency_key` | TEXT | UNIQUE per tenant |
| `created_at` | TIMESTAMPTZ | |

**`statement_lines` table** — NEW, created by migration `migrations/007_statement_lines.sql`:

| Column | Type | Notes |
|---|---|---|
| `tenant_id` | UUID | |
| `statement_line_id` | UUID PK | |
| `allocation_id` | UUID | FK to allocations, NOT NULL |
| `stripe_payment_intent_id` | TEXT | nullable |
| `shopops_order_id` | UUID | nullable |
| `shopops_invoice_id` | UUID | nullable |
| `shopops_customer_id` | UUID | nullable |
| `idempotency_key` | TEXT | UNIQUE per tenant |
| `created_at` | TIMESTAMPTZ | |

---

## 10. Deploy Target

- **Repo:** `bluedevilcollectibles/shopops-api`
- **Branch:** `wo/shopops-billing-allocation-source-of-truth-01`
- **Base branch:** `main`
- **PR:** Closes #119
- **Runtime:** Docker container `shopops-api` — requires image rebuild + restart after merge.
- **Migrations:** `migrations/006_invoice_lines.sql`, `migrations/007_statement_lines.sql` — run against staging Supabase before production deploy.
- **Rule 19:** After container rebuild: `docker exec shopops-api grep -n "validateBillingAllocation" /app/services/billing.js` must return at least one match.

---

## 11. Test Scenarios

**Test 1 — Valid allocation accepted**
- Given: A `customer_pulls` row has been allocated (allocation status = `READY_TO_INVOICE`).
- When: `POST /billing/invoice-lines` is called with `allocation_id` = that allocation's ID and a valid `idempotency_key`.
- Then: HTTP 201 is returned, a row appears in `invoice_lines` with `allocation_id` set, and `invoiced_at` is stamped on the allocation row.

**Test 2 — Unlinked pull rejected**
- Given: A `customer_pulls` row exists with no corresponding allocation.
- When: `POST /billing/invoice-lines` is called with only `pull_id` (no `allocation_id`, no `fulfillment_row_id`).
- Then: HTTP 422 is returned with `{ "error": "BILLING_NO_ALLOCATION_LINKAGE" }` and no row is inserted into `invoice_lines`.

**Test 3 — Orphaned Stripe payment rejected**
- Given: A Stripe `charge.succeeded` webhook payload arrives with no `shopops_order_id`, `shopops_invoice_id`, or `shopops_customer_id` in metadata.
- When: The webhook handler calls `reconcileStripePayment`.
- Then: The function throws `BILLING_ORPHANED_STRIPE_PAYMENT`, HTTP 422 is returned to Stripe (or the error is logged and the charge is flagged in the `orphaned_stripe_charges` table), and no reconciliation row is written.

**Test 4 — Idempotency**
- Given: An invoice line already exists for `(allocation_id, idempotency_key)`.
- When: The same `POST /billing/invoice-lines` call is made again with identical parameters.
- Then: HTTP 200 is returned with the existing row. No duplicate is inserted. Row count in `invoice_lines` for that `allocation_id` remains 1.

**Test 5 — Allocation not yet billable rejected**
- Given: An allocation exists with status = `RESERVED` (not yet `READY_TO_INVOICE`).
- When: `POST /billing/invoice-lines` is called with that `allocation_id`.
- Then: HTTP 422 is returned with `{ "error": "BILLING_NOT_READY_TO_INVOICE" }`.

---

## 12. Stop Point

All of the following must pass before marking REVIEW:

```bash
# 1. Grep assertions pass
grep -rn "BILLING_NO_ALLOCATION_LINKAGE" shopops-api/services/billing.js
grep -rn "BILLING_ORPHANED_STRIPE_PAYMENT" shopops-api/services/stripe.js
grep -rn "validateBillingAllocation" shopops-api/services/billing.js
grep -rn "createInvoiceLine" shopops-api/routes/billing.js
grep -rn "getAllocationById" shopops-api/db/allocations.js

# 2. Test suite passes
cd shopops-api && bun test tests/test_billing_allocation.js
# Expected: >= 5 tests, 0 failures

# 3. Migration files exist
ls shopops-api/migrations/006_invoice_lines.sql
ls shopops-api/migrations/007_statement_lines.sql

# 4. Rule 19 runtime verification (after container rebuild)
docker exec shopops-api grep -n "validateBillingAllocation" /app/services/billing.js
# Expected: at least one matching line

# 5. PR opened
gh pr view --repo bluedevilcollectibles/shopops-api
# Expected: PR exists targeting main, "Closes #119" in body
```

**Given/When/Then CI gate:**
- Given: All 5 grep assertions return matches.
- When: `bun test tests/test_billing_allocation.js` runs against staging Supabase.
- Then: All tests pass (0 failures), PR is open against main with Closes #119, and Rule 19 docker exec confirms source deployed.
