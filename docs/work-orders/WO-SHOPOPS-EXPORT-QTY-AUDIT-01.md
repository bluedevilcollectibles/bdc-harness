# WO-SHOPOPS-EXPORT-QTY-AUDIT-01 — Channel Export Quantity Source Audit

**WO ID:** WO-SHOPOPS-EXPORT-QTY-AUDIT-01
**Priority:** P1
**Builder:** Codex
**Repo:** shopops-api
**GitHub Issue:** #124
**Status:** To Do
**Created:** 2026-05-16
**Reference:** wo-recipe.md (12-section format)

---

## 1. Objective

Audit every channel export path in `shopops-api` — WhatNot, eBay, Shopify, WooCommerce, TikTok,
and native storefront — to determine whether each path reads `safe_available_qty` or the
forbidden raw `on_hand_qty`. Produce a findings document listing every export query, its current
quantity source, and its gap status (COMPLIANT / NON-COMPLIANT / UNKNOWN).

Deliver:
1. A code audit covering every export function that emits inventory quantities to any channel.
2. A findings document at `docs/audits/2026-05-XX-channel-export-qty-audit.md` (date =
   execution date).
3. Inline code comments in any NON-COMPLIANT export path marking it `// TODO WO-EXPORT-FIX: use safe_available_qty`.
4. No automatic query rewrites in this WO — findings doc only (see V1 Limitations).

**What behavior exists AFTER this WO?**
After this WO, there is a canonical record of which export paths are compliant and which are not.
Any NON-COMPLIANT path is tagged in source with a TODO referencing the follow-up fix WO.
Automated remediation is out of scope for this WO.

---

## 2. Behavior Source of Truth

Primary plan document:
`docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Section 6 (Channel Contract) and Section 5.5 (Safe Availability).

All channel export compliance rules, the definition of `safe_available_qty`, and the list of
forbidden direct reads of `on_hand_qty` derive from that plan document.

Secondary references:
- `wo-recipe.md` — 12-section WO template (authoring compliance)
- `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Sections 5.5 and 6
  (canonical spec for safe availability and channel contract)

**Where is the source of truth?**
The plan document at `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` is
authoritative for the channel contract and safe availability formula. The `shopops-api` source
code is ground truth for what queries actually run. Both must be consulted; discrepancies are the
point of this audit.

---

## 3. Prior Art Check

**Plan document consulted:** `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md`
Sections 5.5 and 6 (Safe Availability, Channel Contract).

No prior export audit document exists in `shopops-api/docs/audits/` at the time of WO authoring.
Builder MUST run the following before starting the audit:

```bash
ls shopops-api/docs/audits/ 2>/dev/null \
  && echo "EXISTING audit dir — check for prior export audit" \
  || echo "NEW — create docs/audits/ directory"

grep -rn "on_hand_qty" shopops-api/src/ --include="*.js" --include="*.ts" | head -40
grep -rn "safe_available_qty" shopops-api/src/ --include="*.js" --include="*.ts" | head -40
grep -rn "whatnot\|ebay\|shopify\|woocommerce\|tiktok" shopops-api/src/ \
  --include="*.js" --include="*.ts" -i | head -40
```

---

## 4. System Context

**Owner:** Blue Devil Collectibles (BDC) engineering team — Major Build executes, General
approves architecture.

**Repo:** `bluedevilcollectibles/shopops-api` (Node.js ES modules, Supabase/PostgreSQL)

**Dependencies this WO requires (must be REVIEW or DONE before this WO starts):**
- `WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01` (#113) — `safe_available_qty` function must exist
  in shopops-api so the audit has a canonical reference to compare against
- GitHub CLI (`gh`) authenticated to `bluedevilcollectibles` org
- Docker container `shopops-api` running on BDC server (for Rule 19 runtime verify)

**Adjacent WOs in the same sprint:**
- WO-SHOPOPS-PULL-LIST-OVERSELL-INVARIANT-TESTS-01 (#127) — includes tests that each channel
  export cannot list reserved inventory; those tests depend on this audit identifying the correct
  paths
- WO-STOREFRONT-CHECKOUT-VIA-SHOPOPS-ORDER-01 (#123) — checkout compliance; separate concern

**Who owns this system?**
Blue Devil Collectibles. John Ranson is the sole release authority. General (ChatGPT) owns
architecture decisions. Major Build (Claude Code / Codex) owns execution.

**What MUST NEVER break? (invariants)**
1. The audit MUST NOT modify any query logic (read-only + comment additions only).
2. Every channel export path listed in the findings doc must correspond to an actual function or
   SQL query found in `shopops-api/src/` — no invented or guessed entries.
3. Any NON-COMPLIANT path MUST be tagged in source with `// TODO WO-EXPORT-FIX: use safe_available_qty`.
4. The findings doc MUST list every channel: WhatNot, eBay, Shopify, WooCommerce, TikTok,
   and native storefront. If a channel integration does not exist yet, it MUST be listed as
   UNKNOWN with a note.

---

## 5. UI Hierarchy

No UI changes in this WO. This is a pure audit and documentation WO. Output artifact:

```
docs/audits/2026-05-XX-channel-export-qty-audit.md
```

Findings document structure (mandatory sections):
1. **Summary table** — one row per channel with columns: Channel, Export Function, File:Line,
   Quantity Source, Status (COMPLIANT / NON-COMPLIANT / UNKNOWN)
2. **Per-channel detail** — subsections for WhatNot, eBay, Shopify, WooCommerce, TikTok,
   native storefront; each lists the relevant query/function and the raw SQL or JS excerpt
3. **Gap list** — all NON-COMPLIANT paths with recommended fix (replace `on_hand_qty` with
   `safe_available_qty` call)
4. **V1 Limitations** (see §V1 Limitations below)

Reference: `docs/architecture/2026-05-15-shop-ops-hq-pull-list-engine-spec.md` Section 6,
Channel Contract table.

---

## 6. Mode Behavior Matrix

| Channel | Expected Quantity Source | Compliant If | Non-Compliant If |
|---|---|---|---|
| WhatNot | `safe_available_qty` | Export query calls `safe_available_qty` function | Export query reads `on_hand_qty` directly |
| eBay | `safe_available_qty` | Export query calls `safe_available_qty` function | Export query reads `on_hand_qty` directly |
| Shopify | `safe_available_qty` | Export query calls `safe_available_qty` function | Export query reads `on_hand_qty` directly |
| WooCommerce | `safe_available_qty` | Export query calls `safe_available_qty` function | Export query reads `on_hand_qty` directly |
| TikTok | `safe_available_qty` | Export query calls `safe_available_qty` function | Integration not built → UNKNOWN |
| Native storefront | `safe_available_qty` | Catalog endpoint uses `safe_available_qty` | Catalog endpoint reads `on_hand_qty` directly |

Safe availability formula (per plan doc Section 5.5):
```
safe_available_qty = max(0, on_hand_qty - reserved_qty - channel_listed_elsewhere_qty)
```

**What happens if it runs twice? (idempotency)**
The audit is read-only (greps + SQL SELECTs). Running it twice produces the same findings.
TODO comment tagging is also idempotent — the tag string is identical and `grep -q` will find
it on a re-run without adding a duplicate comment.

---

## 7. Backend Function Inventory

All functions listed below are to be READ (not created) during the audit, with status determined
by code inspection.

| Function / Query | File | Status | Audit Action |
|---|---|---|---|
| WhatNot export handler | `src/exports/whatnot.js` (verify path) | EXISTING (builder must find actual file:line) | Read, classify, tag if NON-COMPLIANT |
| eBay export handler | `src/exports/ebay.js` (verify path) | EXISTING (builder must find actual file:line) | Read, classify, tag if NON-COMPLIANT |
| Shopify inventory sync | `src/exports/shopify.js` (verify path) | EXISTING (builder must find actual file:line) | Read, classify, tag if NON-COMPLIANT |
| WooCommerce export | `src/exports/woocommerce.js` (verify path) | EXISTING (builder must find actual file:line) | Read, classify, tag if NON-COMPLIANT |
| TikTok export | `src/exports/tiktok.js` (verify path) | UNKNOWN — may not exist | List as UNKNOWN if absent |
| Native storefront catalog | `src/routes/catalog.js` (verify path) | EXISTING (builder must find actual file:line) | Read, classify, tag if NON-COMPLIANT |
| `safe_available_qty` function | `src/services/inventory.js` (verify path) | EXISTING per WO-SHOPOPS-SAFE-AVAILABILITY-CANONICAL-01 | Use as compliance reference |

Builder MUST find actual file paths via:
```bash
find shopops-api/src -name "*.js" -o -name "*.ts" | xargs grep -l "whatnot\|ebay\|shopify\|woocommerce\|tiktok\|catalog" 2>/dev/null
```

---

## 8. Data Flow

```
Audit execution (read-only):
  |
  +-- grep -rn "on_hand_qty" shopops-api/src/
  |     --> list all raw quantity reads
  |
  +-- grep -rn "safe_available_qty" shopops-api/src/
  |     --> list all compliant reads
  |
  +-- For each channel export path:
  |     Read function body
  |     Identify SELECT / query that produces inventory quantity
  |     Classify: COMPLIANT / NON-COMPLIANT / UNKNOWN
  |
  +-- For each NON-COMPLIANT path:
  |     Add inline comment:
  |       // TODO WO-EXPORT-FIX: use safe_available_qty instead of on_hand_qty
  |
  v
docs/audits/2026-05-XX-channel-export-qty-audit.md
  (summary table + per-channel detail + gap list + V1 limitations)
```

**Cross-repo note (bdc-xo):** The spec document lives in `bluedevilcollectibles/bdc-xo`. The
implementation lives in `bluedevilcollectibles/shopops-api`. The YAML workflow fetches the spec
from `bdc-xo` at runtime via `gh api`.

### Grep Assertions (Check 8A)

The following greps MUST pass in the `shopops-api` directory after implementation:

```bash
ls shopops-api/docs/audits/ | grep -q "channel-export-qty-audit" \
  || (echo "FAIL: audit findings doc not created" && exit 1)

grep -q "COMPLIANT\|NON-COMPLIANT\|UNKNOWN" \
  shopops-api/docs/audits/*channel-export-qty-audit*.md \
  || (echo "FAIL: findings doc missing status classifications" && exit 1)

grep -q "WhatNot\|whatnot" shopops-api/docs/audits/*channel-export-qty-audit*.md \
  || (echo "FAIL: WhatNot not covered in audit" && exit 1)

grep -q "eBay\|ebay" shopops-api/docs/audits/*channel-export-qty-audit*.md \
  || (echo "FAIL: eBay not covered in audit" && exit 1)

grep -q "Shopify\|shopify" shopops-api/docs/audits/*channel-export-qty-audit*.md \
  || (echo "FAIL: Shopify not covered in audit" && exit 1)

grep -q "WooCommerce\|woocommerce" shopops-api/docs/audits/*channel-export-qty-audit*.md \
  || (echo "FAIL: WooCommerce not covered in audit" && exit 1)

grep -q "V1 Limitations" shopops-api/docs/audits/*channel-export-qty-audit*.md \
  || (echo "FAIL: V1 Limitations section missing" && exit 1)
```

---

## 9. Database Schema References

This WO reads (does not modify) the following columns. Builder MUST verify names against staging
before citing them in the findings doc:

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'inventory_items'
  AND column_name IN ('on_hand_qty', 'reserved_qty', 'channel_listed_elsewhere_qty')
ORDER BY ordinal_position;
```

Expected columns per plan doc Section 5.5:
| Column | Type | Role |
|---|---|---|
| `on_hand_qty` | integer | Raw physical count — MUST NOT be exposed directly to channels |
| `reserved_qty` | integer | Quantity reserved for pull-list allocations |
| `channel_listed_elsewhere_qty` | integer | Quantity committed to other channel listings |
| `safe_available_qty` | computed / function | `max(0, on_hand_qty - reserved_qty - channel_listed_elsewhere_qty)` |

Column claims above come directly from plan doc Section 5.5. Builder MUST run the
`information_schema` query above against staging and record actual column names in the findings
doc before marking REVIEW.

---

## 10. Deploy Target

- **Platform:** `shopops-api` (Node.js, Docker container on BDC server)
- **Environment:** Staging only (no schema changes, no production impact)
- **No migration** — this WO only reads code and writes a findings doc + TODO comments
- **Runtime verify (Rule 19):**
  ```bash
  docker exec shopops-api grep -rn "TODO WO-EXPORT-FIX" /app/src/ 2>&1 | head -20
  ```
  If any NON-COMPLIANT paths were found, the above command must produce at least one line.
  If all paths are COMPLIANT, the command producing no output is acceptable — document that
  outcome in the manifest.
- **No production deploy** without John's explicit "PROCEED DEPLOY."

---

## 11. Test Scenarios

Tests for this WO validate that the audit was executed correctly, not that export logic is fixed
(fixes are deferred per V1 Limitations).

**Test 1 — Findings doc exists and is non-empty**

Given: the audit workflow has completed execution
When: the following command is run:
  ```bash
  wc -l shopops-api/docs/audits/*channel-export-qty-audit*.md
  ```
Then:
- Output shows a line count > 20 (substantive findings, not a stub)
- File exists on disk with a name matching `*channel-export-qty-audit*`
- File contains the string "Summary" (indicating the summary table is present)

**Test 2 — All six channels are documented**

Given: the findings doc exists
When: the following commands are run:
  ```bash
  for channel in WhatNot eBay Shopify WooCommerce TikTok storefront; do
    grep -qi "$channel" shopops-api/docs/audits/*channel-export-qty-audit*.md \
      && echo "PASS: $channel covered" \
      || echo "FAIL: $channel missing"
  done
  ```
Then: all six channels produce "PASS" output

**Test 3 — NON-COMPLIANT paths are tagged in source**

Given: the audit identified at least one NON-COMPLIANT export path
When: the following command is run:
  ```bash
  grep -rn "TODO WO-EXPORT-FIX" shopops-api/src/ | wc -l
  ```
Then: output is >= the count of NON-COMPLIANT entries listed in the findings doc
  (if findings doc lists 0 NON-COMPLIANT, command may return 0 — document this)

**Test 4 — V1 Limitations section present**

Given: the findings doc exists
When:
  ```bash
  grep -q "V1 Limitations" shopops-api/docs/audits/*channel-export-qty-audit*.md \
    && echo "PASS" || echo "FAIL"
  ```
Then: output is "PASS"

**How does CI prove it works?**
```bash
cd shopops-api && bun test tests/exportAudit.test.js
```
The test file asserts: findings doc exists, all 6 channels covered, V1 Limitations present.
GitHub Actions runs this on every PR to `shopops-api/main`.

---

## 12. Stop Point

WO is REVIEW-eligible when ALL of the following CI-executable commands return 0:

**Stop 1 — Findings doc created**
```bash
ls shopops-api/docs/audits/*channel-export-qty-audit*.md \
  && echo "PASS: audit doc exists" \
  || (echo "FAIL: audit doc not found" && exit 1)
```

**Stop 2 — All six channels covered in findings doc**
```bash
for channel in WhatNot eBay Shopify WooCommerce TikTok storefront; do
  grep -qi "$channel" shopops-api/docs/audits/*channel-export-qty-audit*.md \
    && echo "PASS: $channel" \
    || (echo "FAIL: $channel missing" && exit 1)
done
```

**Stop 3 — V1 Limitations section present**
```bash
grep -q "V1 Limitations" shopops-api/docs/audits/*channel-export-qty-audit*.md \
  && echo "PASS" || (echo "FAIL: V1 Limitations missing" && exit 1)
```

**Stop 4 — Test suite passes**
```bash
cd shopops-api && bun test tests/exportAudit.test.js
# Exit code 0 and output contains "4 pass"
```

**Stop 5 — Rule 19 runtime verify (best-effort)**
```bash
RESULT=$(docker exec shopops-api grep -rn "TODO WO-EXPORT-FIX" /app/src/ 2>&1)
if [ $? -eq 0 ]; then
  echo "STATUS=ok — NON-COMPLIANT paths tagged"
  echo "$RESULT"
else
  echo "STATUS=skipped_container_not_rebuilt"
  echo "RULE19_RERUN=docker exec shopops-api grep -rn 'TODO WO-EXPORT-FIX' /app/src/"
fi
```

**Stop 6 — PR opened against shopops-api/main**

Given: all stops 1–5 pass
When: `gh pr view --repo bluedevilcollectibles/shopops-api --json state` is run
Then: output contains `"state":"OPEN"` and PR title includes
  `WO-SHOPOPS-EXPORT-QTY-AUDIT-01` and PR body contains `Closes #124`

All 6 stops must be included in the Captain CI manifest under VALIDATION: PASS.

---

## V1 Limitations

- Does not auto-fix export queries (audit and findings doc only; fixes deferred to a follow-up WO)
- Does not cover POS export paths (POS is a separate channel with its own WO)
- Does not validate TikTok export if that integration is not yet built in `shopops-api/src/`;
  TikTok is listed as UNKNOWN in that case
- Does not cover third-party marketplace APIs not yet integrated (future channels are out of scope)
- Inline TODO comments mark gaps but do not verify that downstream callers are updated
