# WO-STOREFRONT-CHECKOUT-VIA-SHOPOPS-ORDER-01 — Storefront Checkout via Shop Ops Order

**WO ID:** WO-STOREFRONT-CHECKOUT-VIA-SHOPOPS-ORDER-01
**Priority:** P0
**Builder:** Codex
**Repo:** shopops-storefront
**GitHub Issue:** #123
**Status:** To Do
**Created:** 2026-05-16
**Reference:** wo-recipe.md (12-section format)

---

## 1. Objective

Wire the storefront checkout flow so that every successful Stripe payment is backed by a Shop Ops
order created or reconciled before (or atomically with) payment finalization.

Deliver:
1. A `createOrReconcileOrder(tenantId, cartId, customerId, stripePaymentIntentId)` service function
   that inserts or upserts a Shop Ops order row before capturing the Stripe PaymentIntent.
2. A checkout route guard that blocks PaymentIntent confirmation if no Shop Ops order reference
   exists (orphan-payment invariant).
3. Stripe payment metadata updated to include `order_id` and `customer_id` on every charge.
4. An after-payment webhook handler (`stripe.payment_intent.succeeded`) that reconciles any
   order still in `pending` state and marks it `paid`.
5. Unit and integration tests covering the happy path, orphan-payment block, and idempotent
   re-confirmation.

**What behavior exists AFTER this WO?**
After this WO, no Stripe charge can succeed against the storefront without a corresponding Shop
Ops order row. The `order_id` and `customer_id` are stored in Stripe payment metadata on every
charge. Staff can look up a payment in Stripe and immediately find the canonical order in Shop
Ops. Orphaned Stripe charges (no order reference) are impossible from storefront checkout.

---

## 2. Behavior Source of Truth

Primary plan document:
`docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Sections 5.6 (Checkout Flow) and 6 (Channel Contract).

All function names, invariants, metadata field names, and order lifecycle states in this WO
derive exclusively from that plan document. No names are invented.

Secondary references:
- `wo-recipe.md` — 12-section WO template (authoring compliance)
- `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Sections 5.6 and 6
  (canonical spec for checkout and channel contract)

**Where is the source of truth?**
The plan document at `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Sections 5.6 and 6 are authoritative for checkout sequencing, channel contract violations, and
payment metadata requirements. The Supabase staging schema is ground truth for actual column
existence — verify with `information_schema` before asserting column names.

---

## 3. Prior Art Check

**Plan document consulted:** `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Sections 5.6 and 6 (Checkout Flow, Channel Contract).

No existing `createOrReconcileOrder` function has been found in the shopops-storefront codebase
at the time of WO authoring. A builder MUST run the following before writing implementation code:

```bash
grep -r "createOrReconcileOrder" shopops-storefront/src/ 2>/dev/null \
  && echo "EXISTING — read before overwriting" || echo "NEW — safe to create"
grep -r "payment_intent" shopops-storefront/src/ 2>/dev/null | head -20
grep -r "order_id" shopops-storefront/src/ 2>/dev/null | head -20
```

Existing files to check before starting implementation:
- `shopops-storefront/src/routes/` — scan for any checkout or payment route
- `shopops-storefront/src/services/` — scan for any order or payment service
- `shopops-storefront/src/webhooks/` — scan for any Stripe webhook handler

---

## 4. System Context

**Owner:** Blue Devil Collectibles (BDC) engineering team — Major Build executes, General
approves architecture.

**Repo:** `bluedevilcollectibles/shopops-storefront` (React + Node.js backend, Stripe SDK,
Supabase/PostgreSQL). This is NOT shopops-api. There is no `shopops-api/` path prefix and no
Docker container named `shopops-api` for this repo.

**Dependencies this WO requires (must be REVIEW or DONE before this WO starts):**
- `WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01` (#113) — `safe_available_qty` function must exist
  so checkout can verify inventory before order creation
- `WO-SHOPOPS-CUSTOMER-IDENTITY-BINDING-01` (#112) — `mapCustomerIdentity` must exist so
  `customer_id` can be resolved before order creation
- Supabase staging instance accessible (connection string in `.env` as `SUPABASE_URL` /
  `SUPABASE_SERVICE_KEY`)
- Stripe test keys available in `.env` as `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`
- GitHub CLI (`gh`) authenticated to `bluedevilcollectibles` org

**Adjacent WOs in the same sprint:**
- WO-SHOPOPS-EXPORT-QTY-AUDIT-01 (#124) — audit only, no overlap with checkout
- WO-SHOPOPS-PULL-LIST-OVERSELL-INVARIANT-TESTS-01 (#127) — includes a test that storefront
  checkout cannot buy reserved inventory; depends on this WO being complete

**Who owns this system?**
Blue Devil Collectibles. John Ranson is the sole release authority. General (ChatGPT) owns
architecture decisions. Major Build (Claude Code / Codex) owns execution.

**What MUST NEVER break? (invariants)**
1. Every successful Stripe charge MUST have a matching Shop Ops order row — enforced by the
   pre-capture guard; PaymentIntent confirmation is blocked if order is absent.
2. Stripe payment metadata MUST include `order_id` and `customer_id` on every charge.
3. Channels MUST NOT calculate safe sellable quantity from raw `on_hand_qty` (per plan doc
   Section 6 channel contract — call `safe_available_qty` instead).
4. Channels MUST NOT decide customer entitlement or create customer identity outside canonical
   mapping (use `mapCustomerIdentity` from WO-SHOPOPS-CUSTOMER-IDENTITY-BINDING-01).
5. The `createOrReconcileOrder` call MUST be idempotent: duplicate calls with the same
   `(tenantId, cartId, stripePaymentIntentId)` MUST return the same order_id without duplicate
   rows.

---

## 5. UI Hierarchy

No net-new pages in this WO. The checkout flow already exists in the storefront UI. Changes are
to existing checkout component behavior and backend API only:

1. **CheckoutPage** (`src/routes/CheckoutPage.tsx` or equivalent)
   - On "Confirm Purchase" click: calls `POST /api/checkout/orders` to create/reconcile Shop Ops
     order BEFORE displaying Stripe payment element confirmation
   - Receives `order_id` in response; passes to Stripe PaymentElement metadata
   - On Stripe confirmation success: calls `POST /api/checkout/complete` with `order_id`

2. **CheckoutSummary** (child component)
   - Shows order confirmation number (`order_id`) after successful payment

3. **Backend route layer** (`src/routes/api/checkout.js` or `.ts`)
   - `POST /api/checkout/orders` — `createOrReconcileOrder` handler (NEW)
   - `POST /api/checkout/confirm` — PaymentIntent confirmation with guard (MODIFIED)
   - `POST /webhooks/stripe` — Stripe webhook handler (NEW or MODIFIED)

Reference: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 5.6,
"Checkout Sequence Diagram."

---

## 6. Mode Behavior Matrix

| Checkout State | Pre-Capture Action | Guard Outcome | Post-Capture Action |
|---|---|---|---|
| Cart with inventory, no existing order | `createOrReconcileOrder` → new order row | PASS — proceed to Stripe capture | Mark order `paid`, update metadata |
| Cart with existing order (retry/refresh) | `createOrReconcileOrder` → return existing order_id | PASS — proceed to Stripe capture | Mark order `paid` (idempotent) |
| Stripe PaymentIntent without order reference | Pre-capture guard blocks capture | FAIL — return 409, log orphan attempt | No capture |
| `safe_available_qty` = 0 at order creation | `createOrReconcileOrder` rejects | FAIL — return 409 "out of stock" | No order created |
| Reserved inventory (in another pull list) | `safe_available_qty` excludes it | FAIL — return 409 "unavailable" | No order created |
| `stripe.payment_intent.succeeded` webhook | Reconcile order if still `pending` | Mark `paid` | No-op if already `paid` |

**What happens if it runs twice? (idempotency)**
`createOrReconcileOrder(tenantId, cartId, customerId, stripePaymentIntentId)` uses
`INSERT ... ON CONFLICT (tenant_id, stripe_payment_intent_id) DO UPDATE SET updated_at=NOW()`.
Two calls with the same PaymentIntent ID return the same `order_id`. The Stripe webhook handler
also uses `ON CONFLICT` — marking an already-paid order paid again is a no-op.

---

## 7. Backend Function Inventory

All functions listed below are to be created or modified in `shopops-storefront/`.

| Function | File | Status | Notes |
|---|---|---|---|
| `createOrReconcileOrder(tenantId, cartId, customerId, stripePaymentIntentId)` | `src/services/orderService.js` | NEW | Core function — upserts order before Stripe capture |
| `guardPaymentIntent(tenantId, stripePaymentIntentId)` | `src/services/orderService.js` | NEW | Returns order_id or throws if no order found |
| `markOrderPaid(tenantId, orderId)` | `src/services/orderService.js` | NEW | Sets order status = 'paid', records paid_at |
| `attachStripeMetadata(paymentIntentId, orderId, customerId)` | `src/services/stripeService.js` | NEW | Calls Stripe API to update PaymentIntent metadata |
| POST /api/checkout/orders route handler | `src/routes/api/checkout.js` | NEW | Calls createOrReconcileOrder, returns order_id |
| POST /api/checkout/confirm route handler | `src/routes/api/checkout.js` | NEW | Calls guardPaymentIntent then confirms PaymentIntent |
| POST /webhooks/stripe handler | `src/routes/webhooks/stripe.js` | NEW or EXISTING (builder MUST verify) | Handles payment_intent.succeeded → markOrderPaid |
| Migration: `storefront_orders` table | `db/migrations/YYYYMMDD_storefront_orders.sql` | NEW | Creates order tracking table |

Builder must verify `src/routes/webhooks/stripe.js` existence before creating it:
```bash
ls shopops-storefront/src/routes/webhooks/stripe.js 2>/dev/null \
  && echo "EXISTING — read before modifying" || echo "NEW — safe to create"
```

---

## 8. Data Flow

```
CheckoutPage: user clicks "Confirm Purchase"
  |
  v
POST /api/checkout/orders
  |
  +-- mapCustomerIdentity(tenantId, 'STOREFRONT', storefrontAccountId, { email })
  |     --> canonical customer_id
  |
  +-- safe_available_qty check (per WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01)
  |     --> if 0 → 409 "out of stock"
  |
  +-- createOrReconcileOrder(tenantId, cartId, customer_id, stripePaymentIntentId)
  |     --> INSERT INTO storefront_orders ON CONFLICT DO UPDATE
  |     --> returns order_id
  |
  +-- attachStripeMetadata(paymentIntentId, order_id, customer_id)
  |     --> Stripe API: update PaymentIntent metadata
  |
  v
{ order_id } returned to CheckoutPage
  |
  v
CheckoutPage: Stripe PaymentElement.confirm()
  |
  v
POST /api/checkout/confirm
  |
  +-- guardPaymentIntent(tenantId, stripePaymentIntentId)
  |     --> SELECT order_id FROM storefront_orders WHERE stripe_payment_intent_id=$1
  |     --> if NOT FOUND → 409 "orphan payment blocked"
  |
  +-- Stripe.paymentIntents.capture(paymentIntentId)
  |
  v
Stripe webhook: payment_intent.succeeded
  |
  +-- markOrderPaid(tenantId, orderId)
  |     --> UPDATE storefront_orders SET status='paid', paid_at=NOW()
  |
  v
Order confirmed, customer notified
```

**Cross-repo note (bdc-xo):** The spec document lives in `bluedevilcollectibles/bdc-xo`. The
implementation lives in `bluedevilcollectibles/shopops-storefront`. The YAML workflow fetches
the spec from `bdc-xo` at runtime via `gh api`.

### Grep Assertions (Check 8A)

The following greps MUST pass in the `shopops-storefront` directory after implementation:

```bash
grep -r "createOrReconcileOrder" shopops-storefront/src/ | grep -q "." \
  || (echo "FAIL: createOrReconcileOrder not found in src/" && exit 1)

grep -r "guardPaymentIntent" shopops-storefront/src/ | grep -q "." \
  || (echo "FAIL: guardPaymentIntent not found in src/" && exit 1)

grep -r "markOrderPaid" shopops-storefront/src/ | grep -q "." \
  || (echo "FAIL: markOrderPaid not found in src/" && exit 1)

grep -r "order_id" shopops-storefront/src/ --include="*.js" --include="*.ts" | grep "metadata" | grep -q "." \
  || (echo "FAIL: order_id not found in Stripe metadata attachment" && exit 1)

grep -r "ON CONFLICT" shopops-storefront/src/services/orderService.js | grep -q "." \
  || (echo "FAIL: upsert pattern not found in orderService.js" && exit 1)

grep -r "storefront_orders" shopops-storefront/db/ | grep -q "." \
  || (echo "FAIL: migration not found in db/" && exit 1)
```

---

## 9. Database Schema References

### `storefront_orders` table (NEW — this WO creates it)

Migration file: `shopops-storefront/db/migrations/YYYYMMDD_storefront_orders.sql`

```sql
CREATE TABLE IF NOT EXISTS storefront_orders (
  order_id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL,
  customer_id               uuid NOT NULL,
  cart_id                   text NOT NULL,
  stripe_payment_intent_id  text NOT NULL,
  status                    text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','paid','failed','refunded')),
  total_cents               integer NOT NULL,
  currency                  text NOT NULL DEFAULT 'usd',
  metadata                  jsonb DEFAULT '{}',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  paid_at                   timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_storefront_order_payment_intent
  ON storefront_orders (tenant_id, stripe_payment_intent_id);

CREATE INDEX IF NOT EXISTS idx_storefront_order_customer
  ON storefront_orders (tenant_id, customer_id);
```

Column claims above come directly from plan doc Sections 5.6 and 6 and this WO's migration file.
Builder MUST run the following against staging after applying the migration:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'storefront_orders'
ORDER BY ordinal_position;
```

Confirm actual columns match expected before marking REVIEW.

---

## 10. Deploy Target

- **Platform:** `shopops-storefront` (React + Node.js, separate repo from shopops-api)
- **Environment:** Staging Supabase (never production without PROCEED DEPLOY)
- **Migration apply:**
  ```bash
  psql "$SUPABASE_DB_URL" < shopops-storefront/db/migrations/YYYYMMDD_storefront_orders.sql
  ```
- **No docker exec Rule 19 required** — shopops-storefront is NOT a Docker container managed
  under the `shopops-api` image. Deploy via standard git push / CI.
- **No production deploy** without John's explicit "PROCEED DEPLOY."

---

## 11. Test Scenarios

Tests live in `shopops-storefront/tests/checkout.test.js` (or `.ts`). Integration tests run
against staging Supabase and Stripe test keys per Rule 16.

**Test 1 — Happy path: order created before capture**

Given: tenant `t1`, cart `cart_abc`, customer `cust_xyz`, Stripe PaymentIntent `pi_test_001`
  exists in Stripe test mode; `safe_available_qty` for cart items > 0
When: `POST /api/checkout/orders` is called with `{ cartId: 'cart_abc', paymentIntentId: 'pi_test_001' }`
Then:
- Response status 200 with `{ order_id: <uuid> }`
- Row exists in `storefront_orders` with `stripe_payment_intent_id = 'pi_test_001'` and
  `status = 'pending'`
- Stripe PaymentIntent metadata contains `order_id` and `customer_id`
- Assert: `SELECT COUNT(*) FROM storefront_orders WHERE stripe_payment_intent_id='pi_test_001'` = 1

**Test 2 — Orphan payment blocked by guard**

Given: Stripe PaymentIntent `pi_test_orphan` exists in Stripe test mode but NO row in
  `storefront_orders` references it
When: `POST /api/checkout/confirm` is called with `{ paymentIntentId: 'pi_test_orphan' }`
Then:
- Response status 409
- Response body contains `"orphan"` or `"no order"` in error message
- Stripe PaymentIntent is NOT captured (still in `requires_capture` state)
- Assert: `SELECT COUNT(*) FROM storefront_orders WHERE stripe_payment_intent_id='pi_test_orphan'` = 0

**Test 3 — Idempotent order creation (duplicate call)**

Given: order for `(tenant_id='t1', stripe_payment_intent_id='pi_test_001')` already exists
  from Test 1
When: `POST /api/checkout/orders` is called again with the same `paymentIntentId`
Then:
- Response status 200 with the SAME `order_id` as Test 1
- `SELECT COUNT(*) FROM storefront_orders WHERE stripe_payment_intent_id='pi_test_001'` = 1
  (no duplicate row)
- No error or exception is thrown

**Test 4 — Reserved inventory blocks order creation**

Given: all units of a product are in `reserved_qty` (allocated to pull-list subscribers);
  `safe_available_qty` returns 0
When: `POST /api/checkout/orders` is called for a cart containing that product
Then:
- Response status 409 with message indicating out of stock or unavailable
- No row created in `storefront_orders`
- Stripe PaymentIntent is NOT captured

**How does CI prove it works?**
```bash
cd shopops-storefront && bun test tests/checkout.test.js
```
All 4 tests must pass. GitHub Actions runs this suite on every PR to `shopops-storefront/main`.

---

## 12. Stop Point

WO is REVIEW-eligible when ALL of the following CI-executable commands return 0:

**Stop 1 — Migration applied to staging**
```bash
psql "$SUPABASE_DB_URL" -c "SELECT COUNT(*) FROM storefront_orders;" \
  | grep -E "^[[:space:]]*[0-9]" \
  && echo "PASS: storefront_orders table exists" \
  || (echo "FAIL: table missing" && exit 1)
```

**Stop 2 — Unique index exists**
```bash
psql "$SUPABASE_DB_URL" -c \
  "SELECT indexname FROM pg_indexes WHERE tablename='storefront_orders' AND indexname='uq_storefront_order_payment_intent';" \
  | grep -q "uq_storefront_order_payment_intent" \
  && echo "PASS: index exists" || (echo "FAIL: index missing" && exit 1)
```

**Stop 3 — All tests pass**
```bash
cd shopops-storefront && bun test tests/checkout.test.js
# Exit code 0 and output contains "4 pass"
```

**Stop 4 — Grep assertions pass**
```bash
grep -r "createOrReconcileOrder" shopops-storefront/src/ | grep -q "." \
  && echo "PASS" || (echo "FAIL: createOrReconcileOrder missing" && exit 1)
grep -r "guardPaymentIntent" shopops-storefront/src/ | grep -q "." \
  && echo "PASS" || (echo "FAIL: guardPaymentIntent missing" && exit 1)
grep -r "ON CONFLICT" shopops-storefront/src/services/orderService.js | grep -q "." \
  && echo "PASS" || (echo "FAIL: upsert missing" && exit 1)
```

**Stop 5 — PR opened against shopops-storefront/main**

Given: all stops 1–4 pass
When: `gh pr view --repo bluedevilcollectibles/shopops-storefront --json state` is run
Then: output contains `"state":"OPEN"` and PR title includes
  `WO-STOREFRONT-CHECKOUT-VIA-SHOPOPS-ORDER-01` and PR body contains `Closes #123`

All 5 stops must be included in the Captain CI manifest under VALIDATION: PASS.
