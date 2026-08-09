// ============================================================================
// Workforce parameter resolution
// ----------------------------------------------------------------------------
// Rule: the default headcount is 3200 and shift is 8 hours. Any individual
// month may be changed independently. If a month was never changed, it stays
// at the default. There is no hardcoded 3200 anywhere else in the codebase —
// every Total Working Hours / ASR / AFR calculation goes through here.
//
// Resolution order for a given (year, month):
//   1. WorkforceParameter row for that exact year+month  → use it
//   2. SystemSetting default_no_of_workers / default_shift_hours → fallback
//   3. Hard fallback constants (only if settings row is missing entirely)
// ============================================================================
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const HARD_FALLBACK_WORKERS = 3200;
const HARD_FALLBACK_SHIFT_HOURS = 8;

export interface ResolvedWorkforce {
  year: number;
  month: number;
  noOfWorkers: number;
  shiftHours: number;
  workingDays: number;
  totalWorkingHours: number;
  /** true when this month has its own row (i.e. was explicitly set/changed) */
  isExplicitlySet: boolean;
}

/** Calendar days in a month — the legacy workbook's "working days" definition. */
export function calendarDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Working days for a month, capped at today for the current month so an
 * in-progress month doesn't overstate Total Working Hours.
 * Mirrors Monthly report!H3:
 *   (MIN(EOMONTH(...), TODAY()) - DATE(year, startMonth, 1)) + 1
 */
export function workingDaysToDate(
  year: number,
  month: number,
  today: Date = new Date()
): number {
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0);
  if (monthStart > today) return 0; // future month — no hours yet
  const end = monthEnd < today ? monthEnd : today;
  return Math.floor((end.getTime() - monthStart.getTime()) / 86_400_000) + 1;
}

async function getDefault(key: string, hardFallback: number): Promise<number> {
  const setting = await prisma.systemSetting.findUnique({ where: { key } });
  const parsed = setting ? Number(setting.value) : NaN;
  return Number.isFinite(parsed) ? parsed : hardFallback;
}

/**
 * Resolves the effective workforce parameters for one month.
 * Never throws on a missing month — falls back to the configured default.
 */
export async function resolveWorkforce(
  year: number,
  month: number,
  today: Date = new Date()
): Promise<ResolvedWorkforce> {
  const row = await prisma.workforceParameter.findUnique({
    where: { year_month: { year, month } },
  });

  const noOfWorkers =
    row?.noOfWorkers ??
    (await getDefault("default_no_of_workers", HARD_FALLBACK_WORKERS));

  const shiftHours =
    row?.shiftHours !== undefined && row?.shiftHours !== null
      ? Number(row.shiftHours)
      : await getDefault("default_shift_hours", HARD_FALLBACK_SHIFT_HOURS);

  // workingDaysOverride lets an admin exclude weekends/holidays.
  // NULL keeps the legacy calendar-day behaviour.
  const workingDays =
    row?.workingDaysOverride ?? workingDaysToDate(year, month, today);

  return {
    year,
    month,
    noOfWorkers,
    shiftHours,
    workingDays,
    totalWorkingHours: noOfWorkers * workingDays * shiftHours,
    isExplicitlySet: row !== null,
  };
}

/** Sums Total Working Hours across an inclusive month range (for Q/H/YTD filters). */
export async function totalWorkingHoursForRange(
  year: number,
  startMonth: number,
  endMonth: number,
  today: Date = new Date()
): Promise<number> {
  let total = 0;
  for (let m = startMonth; m <= endMonth; m++) {
    const w = await resolveWorkforce(year, m, today);
    total += w.totalWorkingHours;
  }
  return total;
}

/**
 * Updates one month's headcount. Recording who changed it and why is required
 * because it directly shifts that month's ASR and AFR.
 */
export async function setWorkforceForMonth(params: {
  year: number;
  month: number;
  noOfWorkers: number;
  shiftHours?: number;
  workingDaysOverride?: number | null;
  updatedById: number;
  changeReason: string;
}) {
  const shiftHours =
    params.shiftHours ??
    (await getDefault("default_shift_hours", HARD_FALLBACK_SHIFT_HOURS));

  return prisma.workforceParameter.upsert({
    where: { year_month: { year: params.year, month: params.month } },
    update: {
      noOfWorkers: params.noOfWorkers,
      shiftHours,
      workingDaysOverride: params.workingDaysOverride ?? null,
      updatedById: params.updatedById,
      changeReason: params.changeReason,
    },
    create: {
      year: params.year,
      month: params.month,
      noOfWorkers: params.noOfWorkers,
      shiftHours,
      workingDaysOverride: params.workingDaysOverride ?? null,
      updatedById: params.updatedById,
      changeReason: params.changeReason,
    },
  });
}
