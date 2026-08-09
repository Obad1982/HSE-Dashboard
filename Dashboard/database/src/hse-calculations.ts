// ============================================================================
// Energya HSE — Core calculation engine
// ----------------------------------------------------------------------------
// Ports the formulas documented in Phase1_File_Analysis_Report.md §3, read
// verbatim out of ITR Energya Dashboard 2026.xlsx > Action_plan / KPIs calculator.
//
// These functions are pure (no DB access) so they can be unit-tested directly
// against known Excel values. Persistence lives in the service layer.
//
// LOCKED DECISIONS (2026-07-28):
//   - Source value for near-miss is "Near Miss" (with a space)
//   - Injury severity thresholds: Minor 4-15, Moderate 16-45, Major >=46
// ============================================================================

export type ReportSourceValue = "Injury" | "Near Miss" | "Violation";

export type InjurySeverity = "FAC" | "Minor" | "Moderate" | "Major" | "Fatality";

/** One month's slice of a lost-workday period. Unbounded — not capped at 4. */
export interface LostWorkdayAllocation {
  year: number;
  month: number; // 1-12
  lostWorkdays: number;
}

export interface IncidentClassification {
  fac: boolean;
  lti: boolean;
  totalLostWorkdays: number;
  severity: InjurySeverity | null;
  allocations: LostWorkdayAllocation[];
}

// ----------------------------------------------------------------------------
// Date helpers (UTC-normalized to avoid timezone drift shifting a day count)
// ----------------------------------------------------------------------------

function toUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Excel DAYS(end, start) — a plain difference in whole days.
 * DAYS(2026-01-09, 2026-01-05) = 4
 */
export function daysBetween(start: Date, end: Date): number {
  const s = toUtcMidnight(start);
  const e = toUtcMidnight(end);
  return Math.round((e.getTime() - s.getTime()) / 86_400_000);
}

/** Number of days in the given month. month is 1-12. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// ----------------------------------------------------------------------------
// FAC / LTI
// ----------------------------------------------------------------------------

/**
 * FAC — First Aid Case.
 * Excel: IF(AND(Source="Injury", DAYS(Return,Incident)>=0, DAYS(Return,Incident)<=3), 1, 0)
 *
 * Only injuries count. A return date is required — an injury with no return
 * date recorded yet is neither FAC nor LTI until it is supplied.
 */
export function isFAC(
  source: ReportSourceValue,
  incidentDate: Date,
  returnToWorkDate: Date | null | undefined
): boolean {
  if (source !== "Injury" || !returnToWorkDate) return false;
  const d = daysBetween(incidentDate, returnToWorkDate);
  return d >= 0 && d <= 3;
}

/**
 * LTI — Lost Time Injury.
 * Excel: IF(AND(Source="Injury", DAYS(Return,Incident)>=4), 1, 0)
 */
export function isLTI(
  source: ReportSourceValue,
  incidentDate: Date,
  returnToWorkDate: Date | null | undefined
): boolean {
  if (source !== "Injury" || !returnToWorkDate) return false;
  return daysBetween(incidentDate, returnToWorkDate) >= 4;
}

// ----------------------------------------------------------------------------
// Injury severity (dashboard thresholds — the authoritative set per Phase 1 §5.2)
// ----------------------------------------------------------------------------

/**
 * Excel (KPIs calculator!Y:AB, SUMPRODUCT day-range tests):
 *   Minor    : 4  <= days <= 15
 *   Moderate : 16 <= days <= 45
 *   Major    : days >= 46
 *   Fatality : flagged on the incident, not derived from days
 *
 * NOTE: this is deliberately different from the printed form's own checkbox
 * wording (which says Moderate 16-30, Major >30). The form's wording is stored
 * separately as `incident_category`; this computed value is what drives the
 * KPI charts, so the numbers match the legacy dashboard exactly.
 */
export function computeInjurySeverity(
  source: ReportSourceValue,
  incidentDate: Date,
  returnToWorkDate: Date | null | undefined,
  isFatality = false
): InjurySeverity | null {
  if (isFatality) return "Fatality";
  if (source !== "Injury" || !returnToWorkDate) return null;

  const days = daysBetween(incidentDate, returnToWorkDate);
  if (days < 0) return null;
  if (days <= 3) return "FAC";
  if (days <= 15) return "Minor";
  if (days <= 45) return "Moderate";
  return "Major";
}

// ----------------------------------------------------------------------------
// Lost workday allocation across months (UNBOUNDED)
// ----------------------------------------------------------------------------

/**
 * Distributes lost workdays across every calendar month the absence spans.
 *
 * The legacy workbook used four fixed columns (LWDs, LWDs1, LWDs2, LWDs3) and
 * silently dropped anything past the 4th month. This implementation returns one
 * entry per month for an absence of any length, crossing year boundaries
 * correctly — satisfying the brief's requirement to remove the 4-month cap.
 *
 * Semantics preserved from Excel: the total allocated equals
 * DAYS(returnDate, incidentDate), i.e. the incident day itself is counted and
 * the return-to-work day is not. Only LTI cases produce allocations (Excel
 * guards every LWDs column with IF(LTIs=0, 0, ...)).
 *
 * Example: incident 2026-01-28, return 2026-03-05 → 36 total
 *   → [{2026,1,4}, {2026,2,28}, {2026,3,4}]
 */
export function allocateLostWorkdays(
  source: ReportSourceValue,
  incidentDate: Date,
  returnToWorkDate: Date | null | undefined
): LostWorkdayAllocation[] {
  if (!isLTI(source, incidentDate, returnToWorkDate)) return [];

  const total = daysBetween(incidentDate, returnToWorkDate!);
  if (total <= 0) return [];

  const allocations: LostWorkdayAllocation[] = [];
  let remaining = total;

  let year = incidentDate.getUTCFullYear();
  let month = incidentDate.getUTCMonth() + 1; // 1-12
  let dayOfMonth = incidentDate.getUTCDate();

  while (remaining > 0) {
    const daysThisMonth = daysInMonth(year, month);
    // Days available in this month starting from the current position
    const available = daysThisMonth - dayOfMonth + 1;
    const take = Math.min(available, remaining);

    allocations.push({ year, month, lostWorkdays: take });
    remaining -= take;

    // Advance to the 1st of the next month
    dayOfMonth = 1;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return allocations;
}

// ----------------------------------------------------------------------------
// Combined classification
// ----------------------------------------------------------------------------

/**
 * Single entry point used whenever an incident is created or edited.
 * Recomputes every derived field, so changing the return-to-work date
 * automatically flips FAC↔LTI and re-splits the monthly allocation.
 */
export function classifyIncident(params: {
  source: ReportSourceValue;
  incidentDate: Date;
  returnToWorkDate?: Date | null;
  isFatality?: boolean;
}): IncidentClassification {
  const { source, incidentDate, returnToWorkDate, isFatality = false } = params;

  const fac = isFAC(source, incidentDate, returnToWorkDate);
  const lti = isLTI(source, incidentDate, returnToWorkDate);
  const allocations = allocateLostWorkdays(source, incidentDate, returnToWorkDate);
  const totalLostWorkdays = allocations.reduce((sum, a) => sum + a.lostWorkdays, 0);

  return {
    fac,
    lti,
    totalLostWorkdays,
    severity: computeInjurySeverity(source, incidentDate, returnToWorkDate, isFatality),
    allocations,
  };
}

// ----------------------------------------------------------------------------
// KPI formulas
// ----------------------------------------------------------------------------

/**
 * ASR — Accident Severity Rate = LWDs * 200,000 / Total Working Hours
 * Excel: KPIs calculator!D27 → (B27*200000)/C27
 */
export function calculateASR(lostWorkdays: number, totalWorkingHours: number): number | null {
  if (!totalWorkingHours) return null;
  return (lostWorkdays * 200_000) / totalWorkingHours;
}

/**
 * AFR — Accident Frequency Rate = LTIs * 200,000 / Total Working Hours
 * Excel: KPIs calculator!S27 → Q27*200000/R27
 */
export function calculateAFR(ltiCount: number, totalWorkingHours: number): number | null {
  if (!totalWorkingHours) return null;
  return (ltiCount * 200_000) / totalWorkingHours;
}

// ----------------------------------------------------------------------------
// Rating bands (ASR Bullet Chart sheet — admin-editable thresholds)
// ----------------------------------------------------------------------------

export interface RatingBand {
  label: string;
  upperBound: number;
}

/** Confirmed from 'ASR Bullet Chart'!B5:C9 */
export const DEFAULT_ASR_BANDS: RatingBand[] = [
  { label: "Excellent", upperBound: 4 },
  { label: "Very Good", upperBound: 9 },
  { label: "Good", upperBound: 16 },
  { label: "Moderate", upperBound: 30 },
  { label: "Poor", upperBound: 33 }, // 33 = chart axis maximum
];

/** Confirmed from 'ASR Bullet Chart'!C17:D21 */
export const DEFAULT_AFR_BANDS: RatingBand[] = [
  { label: "Excellent", upperBound: 0.2 },
  { label: "Very Good", upperBound: 0.45 },
  { label: "Good", upperBound: 0.8 },
  { label: "Moderate", upperBound: 1.5 },
  { label: "Poor", upperBound: 2.0 }, // 2.0 = chart axis maximum
];

/**
 * Excel: IF(v<=C5,"Excellent",IF(v<=C6,"Very Good",...))
 * Bands are passed in so a System Administrator can change the thresholds
 * without a code change.
 */
export function getRating(value: number | null, bands: RatingBand[]): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  for (const band of bands) {
    if (value <= band.upperBound) return band.label;
  }
  return bands[bands.length - 1]?.label ?? null;
}

// ----------------------------------------------------------------------------
// Period resolution (Monthly report!B3 selector)
// ----------------------------------------------------------------------------

export type PeriodSelector =
  | "YTD" | "Q1" | "Q2" | "Q3" | "Q4" | "H1" | "H2"
  | "Jan" | "Feb" | "Mar" | "Apr" | "May" | "Jun"
  | "Jul" | "Aug" | "Sep" | "Oct" | "Nov" | "Dec";

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/**
 * Excel: KPIs calculator!AE1/AF1 nested IF chain mapping the B3 selection to a
 * start month and end month.
 */
export function resolvePeriod(selector: PeriodSelector): { startMonth: number; endMonth: number } {
  const monthIndex = MONTH_NAMES.indexOf(selector as string);
  if (monthIndex >= 0) {
    const m = monthIndex + 1;
    return { startMonth: m, endMonth: m };
  }
  switch (selector) {
    case "Q1": return { startMonth: 1, endMonth: 3 };
    case "Q2": return { startMonth: 4, endMonth: 6 };
    case "Q3": return { startMonth: 7, endMonth: 9 };
    case "Q4": return { startMonth: 10, endMonth: 12 };
    case "H1": return { startMonth: 1, endMonth: 6 };
    case "H2": return { startMonth: 7, endMonth: 12 };
    case "YTD":
    default:    return { startMonth: 1, endMonth: 12 };
  }
}

// ----------------------------------------------------------------------------
// Due date suggestion from risk classification (Violation / Near Miss form)
// ----------------------------------------------------------------------------

export type RiskLevel = "Very_High_Risk" | "High_Risk" | "Moderate_Risk" | "Low_Risk";

/**
 * Rules printed on the source form (rows 15-21):
 *   Very High Risk — shutdown & correct immediately (due same day; the report
 *                    additionally cannot be closed without an immediate action
 *                    being recorded — enforced in the workflow service)
 *   High Risk      — within 24 hours
 *   Moderate Risk  — within 7 days
 *   Low Risk       — long-term; no automatic date, set by the responsible owner
 */
export function suggestDueDate(risk: RiskLevel, reportDate: Date): Date | null {
  const base = toUtcMidnight(reportDate);
  const addDays = (n: number) => new Date(base.getTime() + n * 86_400_000);

  switch (risk) {
    case "Very_High_Risk": return addDays(0);
    case "High_Risk":      return addDays(1);
    case "Moderate_Risk":  return addDays(7);
    case "Low_Risk":       return null; // set manually per the action plan
  }
}

/** Very High Risk requires an immediate action to be recorded before closure. */
export function requiresImmediateAction(risk: RiskLevel): boolean {
  return risk === "Very_High_Risk";
}
