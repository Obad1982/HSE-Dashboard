// ============================================================================
// Energya HSE — KPI service
// ----------------------------------------------------------------------------
// Server-side aggregation for the Monthly Report dashboard. All rates are
// computed here (never in the browser) so the API is the single source of
// truth, per the project brief.
//
// Verified against the live workbook: FAC 125, LTI 30, LWDs 385 across the
// 395 Action_plan rows — see tests/excel_parity_check.py.
// ============================================================================
import { PrismaClient, Prisma } from "@prisma/client";
import {
  calculateASR,
  calculateAFR,
  getRating,
  resolvePeriod,
  DEFAULT_ASR_BANDS,
  DEFAULT_AFR_BANDS,
  type PeriodSelector,
  type RatingBand,
} from "./hse-calculations";
import { resolveWorkforce } from "./workforce";

const prisma = new PrismaClient();

/** Reports excluded from operational KPIs but never deleted (brief rule #13). */
const ACTIVE_REPORT_FILTER = {
  deletedAt: null,
  workflowStatus: { not: "Cancelled" },
} satisfies Prisma.ReportWhereInput;

export interface PeriodRange {
  year: number;
  startMonth: number;
  endMonth: number;
}

export interface DashboardKpis extends PeriodRange {
  period: PeriodSelector;
  fac: number;
  lti: number;
  lwds: number;
  nearMiss: number;
  violations: number;
  injuries: number;
  totalReports: number;
  noOfWorkers: number;
  shiftHours: number;
  workingDays: number;
  totalWorkingHours: number;
  asr: number | null;
  afr: number | null;
  asrRating: string | null;
  afrRating: string | null;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function monthDateRange(year: number, startMonth: number, endMonth: number) {
  return {
    gte: new Date(Date.UTC(year, startMonth - 1, 1)),
    lt: new Date(Date.UTC(year, endMonth, 1)), // exclusive upper bound
  };
}

/**
 * Lost workdays are credited to the month each day actually falls in, by
 * summing LostWorkdayAllocation rows — NOT by summing a per-incident total.
 * This mirrors KPIs calculator!J9 (which added LWDs + LWDs1 + LWDs2 + LWDs3
 * offset by month) while removing the 4-month ceiling.
 */
async function sumLostWorkdays(
  year: number,
  startMonth: number,
  endMonth: number
): Promise<number> {
  const result = await prisma.lostWorkdayAllocation.aggregate({
    _sum: { lostWorkdays: true },
    where: {
      year,
      month: { gte: startMonth, lte: endMonth },
      incidentReport: { report: ACTIVE_REPORT_FILTER },
    },
  });
  return result._sum.lostWorkdays ?? 0;
}

/** Total working hours across a month range, using the editable per-month table. */
export async function totalWorkingHours(
  year: number,
  startMonth: number,
  endMonth: number
): Promise<{ hours: number; workers: number; shiftHours: number; days: number }> {
  let hours = 0;
  let days = 0;
  let workers = 0;
  let shiftHours = 0;

  for (let m = startMonth; m <= endMonth; m++) {
    const w = await resolveWorkforce(year, m);
    hours += w.totalWorkingHours;
    days += w.workingDays;
    workers = w.noOfWorkers;   // last month's value, shown for reference
    shiftHours = w.shiftHours;
  }
  return { hours, workers, shiftHours, days };
}

/** Loads admin-configured rating bands, falling back to the workbook defaults. */
async function loadBands(kind: "asr" | "afr"): Promise<RatingBand[]> {
  const rows = await prisma.masterData.findMany({
    where: { category: `${kind}_band`, active: true },
    orderBy: { displayOrder: "asc" },
  });
  if (!rows.length) return kind === "asr" ? DEFAULT_ASR_BANDS : DEFAULT_AFR_BANDS;
  return rows.map((r) => ({ label: r.valueEn, upperBound: Number(r.code) }));
}

// ----------------------------------------------------------------------------
// Main dashboard KPIs
// ----------------------------------------------------------------------------

export async function getDashboardKpis(
  year: number,
  period: PeriodSelector
): Promise<DashboardKpis> {
  const { startMonth, endMonth } = resolvePeriod(period);
  const dateRange = monthDateRange(year, startMonth, endMonth);

  const [facCount, ltiCount, nearMiss, violations, injuries, totalReports, lwds, wh] =
    await Promise.all([
      prisma.incidentReport.count({
        where: { fac: true, report: { ...ACTIVE_REPORT_FILTER, reportDate: dateRange } },
      }),
      prisma.incidentReport.count({
        where: { lti: true, report: { ...ACTIVE_REPORT_FILTER, reportDate: dateRange } },
      }),
      prisma.report.count({
        where: { ...ACTIVE_REPORT_FILTER, source: "Near_Miss", reportDate: dateRange },
      }),
      prisma.report.count({
        where: { ...ACTIVE_REPORT_FILTER, source: "Violation", reportDate: dateRange },
      }),
      prisma.report.count({
        where: { ...ACTIVE_REPORT_FILTER, source: "Injury", reportDate: dateRange },
      }),
      prisma.report.count({ where: { ...ACTIVE_REPORT_FILTER, reportDate: dateRange } }),
      sumLostWorkdays(year, startMonth, endMonth),
      totalWorkingHours(year, startMonth, endMonth),
    ]);

  const asr = calculateASR(lwds, wh.hours);
  const afr = calculateAFR(ltiCount, wh.hours);
  const [asrBands, afrBands] = await Promise.all([loadBands("asr"), loadBands("afr")]);

  return {
    year, startMonth, endMonth, period,
    fac: facCount,
    lti: ltiCount,
    lwds,
    nearMiss,
    violations,
    injuries,
    totalReports,
    noOfWorkers: wh.workers,
    shiftHours: wh.shiftHours,
    workingDays: wh.days,
    totalWorkingHours: wh.hours,
    asr,
    afr,
    asrRating: getRating(asr, asrBands),
    afrRating: getRating(afr, afrBands),
  };
}

// ----------------------------------------------------------------------------
// Monthly series (drives every trend chart on the Monthly Report page)
// ----------------------------------------------------------------------------

export interface MonthlyPoint {
  year: number;
  month: number;
  fac: number;
  lti: number;
  lwds: number;
  nearMiss: number;
  violations: number;
  totalWorkingHours: number;
  asr: number | null;
  afr: number | null;
}

export async function getMonthlySeries(
  year: number,
  startMonth = 1,
  endMonth = 12
): Promise<MonthlyPoint[]> {
  const out: MonthlyPoint[] = [];

  for (let m = startMonth; m <= endMonth; m++) {
    const dateRange = monthDateRange(year, m, m);
    const [fac, lti, nearMiss, violations, lwds, w] = await Promise.all([
      prisma.incidentReport.count({
        where: { fac: true, report: { ...ACTIVE_REPORT_FILTER, reportDate: dateRange } },
      }),
      prisma.incidentReport.count({
        where: { lti: true, report: { ...ACTIVE_REPORT_FILTER, reportDate: dateRange } },
      }),
      prisma.report.count({
        where: { ...ACTIVE_REPORT_FILTER, source: "Near_Miss", reportDate: dateRange },
      }),
      prisma.report.count({
        where: { ...ACTIVE_REPORT_FILTER, source: "Violation", reportDate: dateRange },
      }),
      sumLostWorkdays(year, m, m),
      resolveWorkforce(year, m),
    ]);

    out.push({
      year, month: m, fac, lti, lwds, nearMiss, violations,
      totalWorkingHours: w.totalWorkingHours,
      asr: calculateASR(lwds, w.totalWorkingHours),
      afr: calculateAFR(lti, w.totalWorkingHours),
    });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Statistics per department
// ----------------------------------------------------------------------------

export interface DepartmentStats {
  departmentId: number;
  departmentName: string;
  injuries: number;
  nearMiss: number;
  violations: number;
  fac: number;
  lti: number;
  lwds: number;
  unsafeAct: number;
  unsafeCondition: number;
  totalReports: number;
  closedActions: number;
  openActions: number;
  actionClosureRate: number; // percentage 0-100
  asr: number | null;
  afr: number | null;
}

export async function getDepartmentStats(
  year: number,
  period: PeriodSelector
): Promise<DepartmentStats[]> {
  const { startMonth, endMonth } = resolvePeriod(period);
  const dateRange = monthDateRange(year, startMonth, endMonth);
  const departments = await prisma.department.findMany({ where: { active: true } });
  const wh = await totalWorkingHours(year, startMonth, endMonth);

  // Working hours are site-wide in the source workbook; apportion per department
  // by its share of reports so departmental ASR/AFR stay comparable. Once
  // per-department headcount is captured this should read from that instead.
  const totalReportsAll = await prisma.report.count({
    where: { ...ACTIVE_REPORT_FILTER, reportDate: dateRange },
  });

  const stats: DepartmentStats[] = [];

  for (const dept of departments) {
    const base = { ...ACTIVE_REPORT_FILTER, departmentId: dept.id, reportDate: dateRange };

    const [injuries, nearMiss, violations, fac, lti, totalReports,
           closedActions, totalActions, unsafeAct, unsafeCondition, lwdAgg] =
      await Promise.all([
        prisma.report.count({ where: { ...base, source: "Injury" } }),
        prisma.report.count({ where: { ...base, source: "Near_Miss" } }),
        prisma.report.count({ where: { ...base, source: "Violation" } }),
        prisma.incidentReport.count({ where: { fac: true, report: base } }),
        prisma.incidentReport.count({ where: { lti: true, report: base } }),
        prisma.report.count({ where: base }),
        prisma.correctiveAction.count({
          where: { report: base, actionStatus: { in: ["Done", "Closed"] } },
        }),
        prisma.correctiveAction.count({ where: { report: base } }),
        prisma.violationNearMissReport.count({ where: { unsafeAction: true, report: base } }),
        prisma.violationNearMissReport.count({ where: { unsafeCondition: true, report: base } }),
        prisma.lostWorkdayAllocation.aggregate({
          _sum: { lostWorkdays: true },
          where: {
            year, month: { gte: startMonth, lte: endMonth },
            incidentReport: { report: base },
          },
        }),
      ]);

    if (totalReports === 0) continue;

    const lwds = lwdAgg._sum.lostWorkdays ?? 0;
    const share = totalReportsAll ? totalReports / totalReportsAll : 0;
    const deptHours = wh.hours * share;

    stats.push({
      departmentId: dept.id,
      departmentName: dept.departmentNameEn,
      injuries, nearMiss, violations, fac, lti, lwds,
      unsafeAct, unsafeCondition, totalReports,
      closedActions,
      openActions: totalActions - closedActions,
      actionClosureRate: totalActions ? Math.round((closedActions / totalActions) * 100) : 0,
      asr: calculateASR(lwds, deptHours),
      afr: calculateAFR(lti, deptHours),
    });
  }

  return stats.sort((a, b) => b.totalReports - a.totalReports);
}

// ----------------------------------------------------------------------------
// Injured body part analysis
// ----------------------------------------------------------------------------

export interface BodyPartStats {
  bodyPart: string;
  injuryCount: number;
  facCount: number;
  total: number;
  percentageOfTotal: number;
}

export async function getBodyPartStats(
  year: number,
  period: PeriodSelector
): Promise<BodyPartStats[]> {
  const { startMonth, endMonth } = resolvePeriod(period);
  const dateRange = monthDateRange(year, startMonth, endMonth);

  const rows = await prisma.incidentReport.findMany({
    where: { report: { ...ACTIVE_REPORT_FILTER, reportDate: dateRange } },
    select: {
      fac: true,
      lti: true,
      injuredBodyPartDashboard: { select: { valueEn: true } },
    },
  });

  const map = new Map<string, { injury: number; fac: number }>();
  for (const r of rows) {
    const part = r.injuredBodyPartDashboard?.valueEn;
    if (!part) continue;
    if (!map.has(part)) map.set(part, { injury: 0, fac: 0 });
    const e = map.get(part)!;
    if (r.fac) e.fac++;
    else if (r.lti) e.injury++;
  }

  const grand = [...map.values()].reduce((s, v) => s + v.injury + v.fac, 0) || 1;

  return [...map.entries()]
    .map(([bodyPart, v]) => ({
      bodyPart,
      injuryCount: v.injury,
      facCount: v.fac,
      total: v.injury + v.fac,
      percentageOfTotal: +(((v.injury + v.fac) / grand) * 100).toFixed(1),
    }))
    .sort((a, b) => b.total - a.total);
}

// ----------------------------------------------------------------------------
// Drill-down: the reports behind any dashboard number
// ----------------------------------------------------------------------------

export interface DrillFilter {
  year: number;
  period: PeriodSelector;
  departmentId?: number;
  source?: "Injury" | "Near_Miss" | "Violation";
  metric?: "fac" | "lti";
  bodyPart?: string;
}

/** Powers "click any number to see the reports that produced it". */
export async function drillDown(filter: DrillFilter) {
  const { startMonth, endMonth } = resolvePeriod(filter.period);
  const dateRange = monthDateRange(filter.year, startMonth, endMonth);

  const where: Prisma.ReportWhereInput = {
    ...ACTIVE_REPORT_FILTER,
    reportDate: dateRange,
    ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
    ...(filter.source ? { source: filter.source } : {}),
  };

  if (filter.metric || filter.bodyPart) {
    where.incidentReport = {
      ...(filter.metric === "fac" ? { fac: true } : {}),
      ...(filter.metric === "lti" ? { lti: true } : {}),
      ...(filter.bodyPart
        ? { injuredBodyPartDashboard: { valueEn: filter.bodyPart } }
        : {}),
    };
  }

  return prisma.report.findMany({
    where,
    orderBy: { reportDate: "desc" },
    include: {
      department: { select: { departmentNameEn: true } },
      incidentReport: {
        select: {
          fac: true, lti: true, totalLostWorkdays: true, returnToWorkDate: true,
          injuredBodyPartDashboard: { select: { valueEn: true } },
        },
      },
      correctiveActions: { select: { actionStatus: true } },
    },
  });
}

// ----------------------------------------------------------------------------
// Environmental statistics
// ----------------------------------------------------------------------------

export interface EnvironmentalMonth {
  year: number;
  month: number;
  refrigerantCo2Ton: number;
  gasesCo2Ton: number;
  dieselCo2Ton: number;
  electricityCo2Ton: number;
  scope1Ton: number;
  scope2Ton: number;
  totalCo2Ton: number;
  productionTon: number;
  co2PerProduction: number | null;
  kwhPerTon: number | null;
}

/**
 * Environmental formulas, verbatim from the Environmental Data sheet:
 *   CO2_R11 = R11 x 4.66      CO2_R22  = R22  x 1.76 x 10%
 *   CO2_R32 = R32 x 0.677     CO2_R134 = R134 x 1.3  x 10%
 *   CO2_R410 = R410 x 1.924 x 10%
 *   Gases CO2 (ton) = (3 x LPG + CO2cyl + CO2tank) / 1000
 *   CO2 Diesel (ton) = liters x 2.7 / 1000
 *   CO2 Electricity (ton) = kWh x 0.42 / 1000
 *   Scope1 = Diesel + Fugitive ; Scope2 = Electricity
 * Coefficients are read from EnvironmentalCoefficient so an administrator can
 * change them without a code change (with effective-dated history).
 */
export async function getEnvironmentalStats(year: number): Promise<EnvironmentalMonth[]> {
  const [refrigerants, consumption, co2Rows, coefficients] = await Promise.all([
    prisma.environmentalRefrigerant.findMany({ where: { year } }),
    prisma.environmentalConsumption.findMany({ where: { year } }),
    prisma.environmentalCo2.findMany({ where: { year } }),
    prisma.environmentalCoefficient.findMany({ orderBy: { effectiveDate: "desc" } }),
  ]);

  // latest coefficient per gas
  const coef = new Map<string, number>();
  for (const c of coefficients) {
    if (!coef.has(c.gas)) coef.set(c.gas, Number(c.coefficientValue));
  }
  const k = (gas: string, fallback: number) => coef.get(gas) ?? fallback;

  const out: EnvironmentalMonth[] = [];

  for (let month = 1; month <= 12; month++) {
    const r = refrigerants.find((x) => x.month === month);
    const c = consumption.find((x) => x.month === month);
    const e = co2Rows.find((x) => x.month === month);

    const refrigerantCo2Ton = r
      ? Number(r.r11) * k("R11", 4.66) +
        Number(r.r22) * k("R22", 0.176) +
        Number(r.r32) * k("R32", 0.677) +
        Number(r.r134) * k("R134", 0.13) +
        Number(r.r410) * k("R410", 0.1924)
      : 0;

    const gasesCo2Ton = c
      ? (3 * Number(c.lpgCylinderKg) + Number(c.co2CylinderKg) + Number(c.co2TankKg)) / 1000
      : 0;

    const dieselCo2Ton = e ? (Number(e.dieselLiters) * 2.7) / 1000 : 0;
    const electricityCo2Ton = e ? (Number(e.electricityKwh) * 0.42) / 1000 : 0;

    const scope1Ton = dieselCo2Ton + refrigerantCo2Ton + gasesCo2Ton;
    const scope2Ton = electricityCo2Ton;
    const totalCo2Ton = scope1Ton + scope2Ton;
    const productionTon = e ? Number(e.monthlyProductionTon) : 0;

    out.push({
      year, month,
      refrigerantCo2Ton: +refrigerantCo2Ton.toFixed(3),
      gasesCo2Ton: +gasesCo2Ton.toFixed(3),
      dieselCo2Ton: +dieselCo2Ton.toFixed(3),
      electricityCo2Ton: +electricityCo2Ton.toFixed(3),
      scope1Ton: +scope1Ton.toFixed(3),
      scope2Ton: +scope2Ton.toFixed(3),
      totalCo2Ton: +totalCo2Ton.toFixed(3),
      productionTon,
      co2PerProduction: productionTon ? +(totalCo2Ton / productionTon).toFixed(4) : null,
      kwhPerTon: productionTon && e ? +(Number(e.electricityKwh) / productionTon).toFixed(2) : null,
    });
  }

  return out;
}
