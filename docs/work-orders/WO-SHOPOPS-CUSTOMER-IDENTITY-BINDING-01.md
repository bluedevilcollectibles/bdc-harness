# WO-SHOPOPS-CUSTOMER-IDENTITY-BINDING-01 — Canonical Customer Identity Mapper

**WO ID:** WO-SHOPOPS-CUSTOMER-IDENTITY-BINDING-01
**Priority:** P0
**Builder:** Codex
**Repo:** shopops-api
**GitHub Issue:** #112
**Status:** To Do
**Created:** 2026-05-16
**Reference:** wo-recipe.md (12-section format)

---

## 1. Objective

Build the canonical customer identity mapper for Shop Ops HQ. Every channel that creates or
references a customer — STOREFRONT, POS, SHOPIFY, WHATNOT, EBAY, WOOCOMMERCE, TIKTOK, LOCG,
MANUAL — must map external customer identifiers to a single internal `customer_id` through this
mapper. Channels must never synthesize permanent customer IDs independently.

Deliver:
1. A `customer_identity_bindings` table (or equivalent migration) enforcing
   `UNIQUE (tenant_id, source, external_id)` where `external_id IS NOT NULL`.
2. A `mapCustomerIdentity(tenantId, source, externalId, hints)` service function that upserts a
   binding and returns the canonical `customer_id`.
3. A `getOrCreateCustomer(tenantId, hints)` helper that upserts the `customers` table row and
   returns `customer_id`.
4. Unit tests covering every source enum value, duplicate-binding idempotency, and cross-channel
   merge detection.

**What behavior exists AFTER this WO?**
After this WO, no channel code may create a `customer_id` without first calling
`mapCustomerIdentity`. All existing channel entry-points (Shopify webhook handler, LOCG import,
POS sale flow) must be updated to call the mapper. Duplicate cross-channel rows for the same
natural person are prevented at the database level.

---

## 2. Behavior Source of Truth

Primary plan document:
`docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Section 4 — Customer Identity.

All table names, column names, source enum values, and uniqueness rules in this WO derive
exclusively from that plan document. No names are invented.

Secondary references:
- `wo-recipe.md` — 12-section WO template (authoring compliance)
- `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` (canonical spec)

**Where is the source of truth?**
The plan document at `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Section 4 is the authoritative definition of identity binding behavior, source enum values, and
uniqueness constraints. The Supabase staging schema is ground truth for actual column existence
(verify with `information_schema` before asserting column names).

---

## 3. Prior Art Check

**Plan document consulted:** `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Section 4, Customer Identity.

No existing `customer_identity_bindings` table has been found in the shopops-api codebase at the
time of WO authoring. A builder MUST run the following before writing migration code:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('customer_identity_bindings', 'customers');
```

If either table already exists, the builder must read its current columns via
`information_schema.columns` before writing any migration, to avoid destructive ALTER TABLE
conflicts.

Existing files to check before starting implementation:
- `shopops-api/db/migrations/` — scan for any prior customer or identity migration
- `shopops-api/services/` — scan for any file named `customer*`
- `shopops-api/models/` — scan for any customer model

---

## 4. System Context

**Owner:** Blue Devil Collectibles (BDC) engineering team — Major Build executes, General
approves architecture.

**Repo:** `bluedevilcollectibles/shopops-api` (Node.js ES modules, Supabase/PostgreSQL)

**Dependencies this WO requires:**
- Supabase staging instance accessible (connection string in `.env` as `SUPABASE_URL` /
  `SUPABASE_SERVICE_KEY`)
- `shopops-api` Node.js project running (Bun or Node test runner available)
- Existing `customers` table must exist OR migration for it must be in this WO's scope (see §9)
- GitHub CLI (`gh`) authenticated to `bluedevilcollectibles` org
- Docker container `shopops-api` running on BDC server (for Rule 19 runtime verify)

**Adjacent WOs in the same sprint:**
- WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01 (#113) — reads from `inventory_items`, no overlap
- WO-SHOPOPS-PULL-LIST-CUSTOMER-PULL-MODEL-01 (#115) — depends on `customer_id` from this WO;
  must be executed AFTER this WO reaches REVIEW

**Who owns this system?**
Blue Devil Collectibles. John Ranson is the sole release authority. General (ChatGPT) owns
architecture decisions. Major Build (Claude Code / Codex) owns execution.

**What MUST NEVER break? (invariants)**
1. `(tenant_id, source, external_id)` must be UNIQUE in `customer_identity_bindings` where
   `external_id IS NOT NULL` — enforced by database constraint, not application logic alone.
2. A call to `mapCustomerIdentity` must be idempotent: two calls with identical arguments must
   return the same `customer_id` without creating a duplicate row.
3. The `customers` table `customer_id` must be the sole canonical identifier for a natural
   person across all channels. No channel may generate or store a different permanent ID.
4. `tenant_id` must always be present on every row — no orphan bindings.

---

## 5. UI Hierarchy

No direct UI changes in this WO. The identity mapper is a backend service consumed by:

1. **Staff-facing POS** — customer lookup at point of sale calls `mapCustomerIdentity(tenantId,
   'POS', posCustomerId, { email, phone, displayName })`
2. **Shopify webhook handler** — `customer/create` and `order/create` events call
   `mapCustomerIdentity(tenantId, 'SHOPIFY', shopifyCustomerId, { email })`
3. **LOCG import pipeline** — each LOCG row calls `mapCustomerIdentity(tenantId, 'LOCG',
   locgCustomerId, hints)`
4. **WHATNOT / EBAY / WOOCOMMERCE / TIKTOK / STOREFRONT / MANUAL** — each entry point calls
   mapper before touching any pull list or order table

Reference: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 4,
diagram "Channel Customer Resolution Flow."

---

## 6. Mode Behavior Matrix

| Channel | Source Enum | External ID Field | Hint Fields Used | Fallback if No External ID |
|---|---|---|---|---|
| Shopify | `SHOPIFY` | `shopify_customer_id` | email | create new customer |
| POS | `POS` | `pos_customer_id` | email, phone | create new customer |
| WHATNOT | `WHATNOT` | `whatnot_user_id` | email | create new customer |
| eBay | `EBAY` | `ebay_buyer_id` | email | create new customer |
| WooCommerce | `WOOCOMMERCE` | `woo_customer_id` | email | create new customer |
| TikTok | `TIKTOK` | `tiktok_user_id` | email | create new customer |
| LOCG | `LOCG` | `locg_customer_id` | email, phone | create new customer |
| Storefront | `STOREFRONT` | `storefront_account_id` | email, phone | create new customer |
| Manual | `MANUAL` | null (no external ID) | email, phone, displayName | always create new |

For `MANUAL` source, `external_id` is NULL; uniqueness constraint does not apply (partial unique
index on `external_id IS NOT NULL`). All other sources require a non-null `external_id`.

**What happens if it runs twice? (idempotency)**
`mapCustomerIdentity(tenantId, source, externalId, hints)` uses an `INSERT ... ON CONFLICT
(tenant_id, source, external_id) DO UPDATE SET updated_at = NOW()` pattern (upsert). The
returned `customer_id` is identical on every call with the same `(tenant_id, source,
externalId)`. No duplicate rows are created. Running the migration twice is safe because it uses
`CREATE TABLE IF NOT EXISTS` and `CREATE UNIQUE INDEX IF NOT EXISTS`.

---

## 7. Backend Function Inventory

All functions listed below are to be created in `shopops-api/`.

| Function | File | Status | Notes |
|---|---|---|---|
| `mapCustomerIdentity(tenantId, source, externalId, hints)` | `services/customerIdentity.js` | NEW | Core mapper — upserts binding, returns customer_id |
| `getOrCreateCustomer(tenantId, hints)` | `services/customerIdentity.js` | NEW | Upserts customers row, returns customer_id |
| `resolveByEmail(tenantId, emailNorm)` | `services/customerIdentity.js` | NEW | Lookup existing customer by normalized email |
| `normalizeEmail(raw)` | `utils/normalize.js` | NEW (or EXISTING if present) | Lowercases, trims, removes dots in Gmail local |
| `normalizePhone(raw)` | `utils/normalize.js` | NEW (or EXISTING if present) | E.164 format, strips non-digits |
| Migration: `customer_identity_bindings` | `db/migrations/YYYYMMDD_customer_identity_bindings.sql` | NEW | Creates table + partial unique index |
| Migration: `customers` (if not present) | `db/migrations/YYYYMMDD_customers.sql` | NEW or EXISTING — builder MUST verify |

Builder must verify `utils/normalize.js` existence before creating it:
```bash
ls shopops-api/utils/normalize.js 2>/dev/null && echo EXISTING || echo NEW
```

---

## 8. Data Flow

```
Channel event (Shopify webhook / POS sale / LOCG import / ...)
  |
  v
mapCustomerIdentity(tenantId, source, externalId, hints)
  |
  +-- Query: SELECT customer_id FROM customer_identity_bindings
  |          WHERE tenant_id=$1 AND source=$2 AND external_id=$3
  |
  |   [FOUND] --> return customer_id (fast path, no write)
  |
  +-- [NOT FOUND] --> getOrCreateCustomer(tenantId, hints)
  |     |
  |     +-- resolveByEmail(tenantId, normalizeEmail(hints.email))
  |     |   [FOUND] --> reuse customer_id
  |     |   [NOT FOUND] --> INSERT INTO customers (...) RETURNING customer_id
  |     |
  |     v
  |   INSERT INTO customer_identity_bindings
  |          (tenant_id, source, external_id, customer_id, metadata)
  |   ON CONFLICT (tenant_id, source, external_id) DO UPDATE SET updated_at=NOW()
  |   RETURNING customer_id
  |
  v
canonical customer_id returned to caller
```

**Cross-repo note (bdc-xo):** The spec document lives in `bluedevilcollectibles/bdc-xo`. The
implementation lives in `bluedevilcollectibles/shopops-api`. The YAML workflow fetches the spec
from `bdc-xo` at runtime via `gh api`.

### Grep Assertions (Check 8A — bdc-xo cross-repo)

The following greps MUST pass in the `shopops-api` directory after implementation:

```bash
grep -r "mapCustomerIdentity" shopops-api/services/ | grep -q "." \
  || (echo "FAIL: mapCustomerIdentity not found in services/" && exit 1)

grep -r "getOrCreateCustomer" shopops-api/services/ | grep -q "." \
  || (echo "FAIL: getOrCreateCustomer not found in services/" && exit 1)

grep -r "customer_identity_bindings" shopops-api/db/ | grep -q "." \
  || (echo "FAIL: migration not found in db/" && exit 1)

grep -r "ON CONFLICT" shopops-api/services/customerIdentity.js | grep -q "." \
  || (echo "FAIL: upsert pattern not found in customerIdentity.js" && exit 1)

grep -r "normalizeEmail" shopops-api/ --include="*.js" | grep -q "." \
  || (echo "FAIL: normalizeEmail not found" && exit 1)
```

---

## 9. Database Schema References

### `customers` table

Columns per plan doc Section 4. Builder MUST verify against Supabase staging:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'customers'
ORDER BY ordinal_position;
```

Expected columns (from plan doc):
| Column | Type | Nullable |
|---|---|---|
| `customer_id` | uuid (PK) | NO |
| `tenant_id` | uuid (FK) | NO |
| `display_name` | text | YES |
| `email` | text | YES |
| `email_norm` | text | YES |
| `phone` | text | YES |
| `status` | text | NO (default 'active') |
| `created_at` | timestamptz | NO |
| `updated_at` | timestamptz | NO |

### `customer_identity_bindings` table (NEW — this WO creates it)

Migration file: `shopops-api/db/migrations/YYYYMMDD_customer_identity_bindings.sql`

```sql
CREATE TABLE IF NOT EXISTS customer_identity_bindings (
  binding_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  customer_id   uuid NOT NULL REFERENCES customers(customer_id),
  source        text NOT NULL CHECK (source IN (
                  'STOREFRONT','POS','SHOPIFY','WHATNOT','EBAY',
                  'WOOCOMMERCE','TIKTOK','LOCG','MANUAL')),
  external_id   text,
  email         text,
  phone         text,
  metadata      jsonb DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Partial unique index: uniqueness only where external_id is present
CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_binding_external
  ON customer_identity_bindings (tenant_id, source, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_identity_binding_customer
  ON customer_identity_bindings (tenant_id, customer_id);
```

Column claims above come directly from plan doc Section 4 and this WO's migration file. The
builder MUST run the `information_schema` query above against staging after applying the
migration to confirm actual schema matches spec before marking REVIEW.

---

## 10. Deploy Target

- **Platform:** `shopops-api` (Node.js, Docker container on BDC server)
- **Environment:** Staging Supabase (never production without PROCEED DEPLOY)
- **Migration apply:** `psql $SUPABASE_DB_URL < shopops-api/db/migrations/YYYYMMDD_customer_identity_bindings.sql`
- **Runtime verify (Rule 19):**
  ```bash
  docker exec shopops-api grep -n "mapCustomerIdentity" /app/services/customerIdentity.js
  ```
  If the container has not been rebuilt since code was added, `STATUS=skipped_container_not_rebuilt`
  is acceptable in the manifest — but the RULE19_RERUN command must be included.
- **No production deploy** without John's explicit "PROCEED DEPLOY."

---

## 11. Test Scenarios

Tests live in `shopops-api/tests/customerIdentity.test.js` (or `.ts`). All tests run against
staging Supabase (not mocks) per Rule 16.

**Test 1 — New binding creation**

Given: a tenant `t1`, source `SHOPIFY`, `external_id = "shopify_999"`, no prior binding exists
When: `mapCustomerIdentity('t1', 'SHOPIFY', 'shopify_999', { email: 'alice@example.com' })` is called
Then:
- Returns a valid UUID `customer_id`
- A row exists in `customer_identity_bindings` with `(tenant_id='t1', source='SHOPIFY', external_id='shopify_999')`
- A row exists in `customers` with `email_norm = 'alice@example.com'`
- Assert: `SELECT COUNT(*) FROM customer_identity_bindings WHERE external_id='shopify_999'` = 1

**Test 2 — Idempotency (same binding called twice)**

Given: binding for `('t1', 'SHOPIFY', 'shopify_999')` already exists from Test 1
When: `mapCustomerIdentity('t1', 'SHOPIFY', 'shopify_999', { email: 'alice@example.com' })` is called a second time
Then:
- Returns the identical `customer_id` as Test 1
- `SELECT COUNT(*) FROM customer_identity_bindings WHERE external_id='shopify_999'` = 1 (no duplicate)
- No error or exception is thrown

**Test 3 — Cross-channel merge by email**

Given: customer Alice already exists in `customers` with `email_norm = 'alice@example.com'`
  (created via Shopify binding in Test 1)
When: `mapCustomerIdentity('t1', 'WHATNOT', 'whatnot_777', { email: 'Alice@example.com' })` is called
  (email differs only in casing)
Then:
- Returns the SAME `customer_id` as Test 1 (email normalization merged them)
- Two rows exist in `customer_identity_bindings` (one SHOPIFY, one WHATNOT) both pointing to
  the same `customer_id`
- Assert: `SELECT COUNT(DISTINCT customer_id) FROM customer_identity_bindings WHERE tenant_id='t1'` = 1

**Test 4 — MANUAL source (null external_id)**

Given: no prior MANUAL binding for this tenant
When: `mapCustomerIdentity('t1', 'MANUAL', null, { email: 'bob@example.com', displayName: 'Bob' })` is called
Then:
- Returns a valid `customer_id`
- No uniqueness error (partial index excludes null external_id)
- Calling it again creates a SECOND row (MANUAL is intentionally non-idempotent)

**Test 5 — Duplicate external_id rejected at DB level**

Given: `('t1', 'EBAY', 'ebay_123')` binding exists
When: a raw INSERT with identical `(tenant_id, source, external_id)` is attempted directly
Then:
- Database throws a unique-constraint violation
- `mapCustomerIdentity` (via ON CONFLICT) does NOT throw but returns existing `customer_id`

**How does CI prove it works?**
```bash
cd shopops-api && bun test tests/customerIdentity.test.js
```
All 5 tests must pass. CI (GitHub Actions) runs this suite on every PR to `shopops-api/main`.

---

## 12. Stop Point

WO is REVIEW-eligible when ALL of the following CI-executable commands return 0 and produce
expected output:

**Stop 1 — Migration applied to staging**
```bash
psql "$SUPABASE_DB_URL" -c "SELECT COUNT(*) FROM customer_identity_bindings;" \
  | grep -q "^(0 rows\|[0-9]" \
  && echo "PASS: table exists" || (echo "FAIL: table missing" && exit 1)
```

**Stop 2 — Unique index exists**
```bash
psql "$SUPABASE_DB_URL" -c \
  "SELECT indexname FROM pg_indexes WHERE tablename='customer_identity_bindings' AND indexname='uq_identity_binding_external';" \
  | grep -q "uq_identity_binding_external" \
  && echo "PASS: index exists" || (echo "FAIL: index missing" && exit 1)
```

**Stop 3 — All unit tests pass**
```bash
cd shopops-api && bun test tests/customerIdentity.test.js
# Exit code 0 and output contains "5 pass"
```

**Stop 4 — Grep assertions pass**
```bash
grep -r "mapCustomerIdentity" shopops-api/services/customerIdentity.js | grep -q "." \
  && echo "PASS" || (echo "FAIL" && exit 1)
grep -r "ON CONFLICT" shopops-api/services/customerIdentity.js | grep -q "." \
  && echo "PASS" || (echo "FAIL" && exit 1)
```

**Stop 5 — Rule 19 runtime verify (best-effort)**
```bash
docker exec shopops-api grep -n "mapCustomerIdentity" /app/services/customerIdentity.js 2>&1 \
  | tee /dev/stderr \
  && echo "STATUS=ok" || echo "STATUS=skipped_container_not_rebuilt — include RULE19_RERUN in manifest"
```

**Stop 6 — PR opened against shopops-api/main**

Given: all stops 1–5 pass
When: `gh pr view --repo bluedevilcollectibles/shopops-api --json state` is run
Then: output contains `"state":"OPEN"` and PR title includes `WO-SHOPOPS-CUSTOMER-IDENTITY-BINDING-01`
and PR body contains `Closes #112`

All 6 stops must be included in the Captain CI manifest under VALIDATION: PASS.
