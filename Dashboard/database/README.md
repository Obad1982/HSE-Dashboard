# Energya HSE — Database Layer

This folder is the Phase 5 deliverable (Database) for the Energya HSE Incident,
Near Miss, Violation & Interactive Dashboard System. It implements the ERD and
resolves the conflicts documented in `Phase1_File_Analysis_Report.md`.

## Contents

- `prisma/schema.prisma` — full relational schema (25 models) for PostgreSQL.
- `prisma/seed.ts` — seeds Roles, Departments, and every MasterData category
  with the exact bilingual lists confirmed by direct inspection of the three
  Excel workbooks (locations, incident causes, unsafe acts/conditions, body
  parts with detail→dashboard mapping, environmental CO2 coefficients).
- `sql/vw_action_plan_compat.sql` — a read-only compatibility view that
  reconstructs the legacy `Action_plan` 24-column shape (original Arabic
  headers) from the normalized tables, used only to validate imported data
  and formula parity against the old Excel dashboard — the application UI
  never queries this view directly.

## Locked decisions this schema encodes

1. `ReportSource` enum stores `Near Miss` **with a space** at the database
   level (`@map("Near Miss")` on the Prisma enum value) — matches the legacy
   Action_plan data and every existing chart formula.
2. `IncidentReport.injury_severity_computed` is a separate, server-only
   field using the dashboard's day-count thresholds (4–15 / 16–45 / ≥46),
   kept independent from `incident_category` (the checkbox wording printed
   on the original form). Both are stored; neither is derived from the other.
3. `FAC`, `LTI`, `total_lost_workdays` and `LostWorkdayAllocation` rows are
   **always server-computed** — there is intentionally no way for a normal
   user role to type these values in; only System Administrator-level access
   can set `manual_override = true` with a required `manual_override_reason`.
4. Lost workdays are **not capped at 4 months**: `LostWorkdayAllocation` has
   one row per `(incident_report_id, year, month)`, so a recovery spanning
   any number of calendar months is representable — unlike the Excel
   workbook's fixed `LWDs/LWDs1/LWDs2/LWDs3` columns.
5. **Number of workers is fully editable per month.**
   `WorkforceParameter(year, month, no_of_workers, shift_hours,
   working_days_override)` replaces the workbook's hardcoded constants
   (3200 workers, 8 shift hours, calendar-day count) with one editable row
   per month:
   - `no_of_workers` — set the real headcount for each month independently.
   - `shift_hours` — also per-month editable (not fixed at 8).
   - `working_days_override` — leave `NULL` to keep the legacy calendar-day
     behaviour, or set a number to exclude weekends/holidays.
   - `updated_by_id` + `change_reason` + `updated_at` — every edit is
     attributable, because changing headcount changes that month's
     Total Working Hours and therefore its ASR and AFR.

   The seed back-fills all 12 months of 2026 at 3200/8 **only as a starting
   value** so the app reproduces the legacy dashboard exactly on day one;
   the seed uses `update: {}` so re-running it never overwrites a value an
   administrator has since corrected. There is no `3200` literal anywhere in
   the application logic — Total Working Hours always reads this table.
6. `Department.legacy_value` and `MasterData.legacy_value` preserve original
   (including misspelled) source text — e.g. `Maintinance`, `Plastring` — for
   audit, while the canonical `department_name_en` / `value_en` is corrected.
7. `Report.deleted_at` + `workflow_status = 'Cancelled'` implement soft
   delete — no report is ever hard-deleted, per the brief.

## Setup

```bash
cp .env.example .env   # fill in real DATABASE_URL
npm install prisma @prisma/client
npx prisma migrate dev --name init
npx prisma db execute --file sql/vw_action_plan_compat.sql
npx prisma db seed
```

## Service layer (`src/`)

| File | Responsibility |
|---|---|
| `hse-calculations.ts` | Pure functions: FAC, LTI, injury severity, unbounded month-by-month lost-workday allocation, ASR/AFR, rating bands, period resolution, due-date suggestion. No DB access, so it is directly unit-testable. |
| `workforce.ts` | Resolves headcount / shift hours / working days per month with the SystemSetting fallback; computes Total Working Hours. |
| `kpi-service.ts` | Dashboard aggregation: KPI cards, monthly series, department statistics, body-part analysis, drill-down, environmental figures. |
| `report-service.ts` | Report numbering, create/update (always recomputing derived fields), workflow transitions, corrective actions, audit logging, notifications. |

### Guarantees enforced in the service layer

- **Derived fields are never accepted from the client.** `applyClassification()`
  recomputes FAC / LTI / LWDs and rewrites the allocation rows on every create
  *and* every update, so editing a return-to-work date automatically flips the
  classification and re-splits the months.
- **Report numbers are concurrency-safe.** Numbering runs inside a transaction
  and retries on the `report_number` unique-constraint violation, so two users
  saving simultaneously can never receive the same number.
- **Workflow transitions are validated** against an explicit state map;
  `Done` and `Closed` are distinct states (brief rule #12).
- **Very High Risk cannot be closed** without a recorded immediate action, and
  no report can be closed while corrective actions remain open.
- **Cancelling soft-deletes** (sets `deleted_at` + `Cancelled`), removing the
  report from KPIs while preserving it and its audit trail.

## Tests

```bash
node tests/hse-calculations.test.mjs   # 48 assertions — formula correctness
node tests/workflow.test.mjs           # 17 assertions — state machine + numbering
python3 tests/excel_parity_check.py "../ITR Energya Dashboard 2026.xlsx"
```

The parity check is the acceptance test for brief requirement #34. Latest run:

```
Rows checked: 395
FAC  app=125  excel=125  row-mismatches=0  [OK]
LTI  app=30   excel=30   row-mismatches=0  [OK]
LWDs app=385  excel=385  row-mismatches=0  [OK]
PARITY CONFIRMED — 0 total row mismatches
```

## Next steps (not yet built)

- API routes / Next.js frontend wiring (Phases 6–8).
- Import script (Phase 9) to load the 395 live `Action_plan` rows through this
  schema, re-running the parity check afterwards against the persisted data.
- Puppeteer print templates (Phase 10).
