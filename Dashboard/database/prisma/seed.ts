// ============================================================================
// Energya HSE — Seed script
// Populates Roles, Departments and all MasterData categories with the exact
// bilingual lists confirmed by direct inspection of the three source
// workbooks (see Phase1_File_Analysis_Report.md, section 1 & 2).
// Run: npx prisma db seed
// ============================================================================
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // ---------------------------------------------------------------- Roles
  const roles = [
    "HSE Reporter",
    "HSE Officer",
    "HSE Supervisor",
    "Department Supervisor",
    "HSE Manager",
    "System Administrator",
  ];
  for (const roleName of roles) {
    await prisma.role.upsert({
      where: { roleName },
      update: {},
      create: { roleName },
    });
  }

  // ------------------------------------------------------------ Departments
  // Distinct values actually found in Action_plan (395 live rows), with
  // typos normalized and preserved in legacy_value per Conflict #3.
  const departments: { code: string; en: string; legacy?: string }[] = [
    { code: "TOWER", en: "Tower" },
    { code: "STEEL", en: "Steel" },
    { code: "PLATE", en: "Plate" },
    { code: "POLES", en: "Poles" },
    { code: "GALVANIZING", en: "Galvanizing" },
    { code: "PAINTING", en: "Painting" },
    { code: "WH", en: "Warehouse" },
    { code: "DISPATCH", en: "Dispatch" },
    { code: "MAINTENANCE", en: "Maintenance", legacy: "Maintinance" },
    { code: "PLASTERING", en: "Plastering", legacy: "Plastring" },
    { code: "ERECTION", en: "Erection" }, // named in brief, not yet seen in live data — kept for forward compatibility
  ];
  for (const d of departments) {
    await prisma.department.upsert({
      where: { departmentCode: d.code },
      update: {},
      create: {
        departmentCode: d.code,
        departmentNameEn: d.en,
        legacyValue: d.legacy,
      },
    });
  }

  // ------------------------------------------------------------- MasterData
  type MD = { category: string; code: string; en: string; ar?: string; mapping?: string; order?: number };

  const incidentLocations: MD[] = [
    { category: "location", code: "PRODUCTION_HALL", en: "Production Hall", ar: "داخل صالة الانتاج" },
    { category: "location", code: "EXTERNAL_YARDS", en: "External Yards", ar: "الساحات الخارجية" },
    { category: "location", code: "WASTE_AREA", en: "Waste Area", ar: "منطقة المخلفات" },
    { category: "location", code: "INTERNAL_WAREHOUSE", en: "Internal Warehouse", ar: "المخازن الداخلية" },
    { category: "location", code: "EXTERNAL_WAREHOUSE", en: "External Warehouse", ar: "المخازن الخارجية" },
    { category: "location", code: "OUTSIDE_FACTORY", en: "Outside the Factory", ar: "خارج المصنع" },
    { category: "location", code: "COMPANY_TRANSPORT", en: "Company Transportation", ar: "مواصلات الشركة" },
    { category: "location", code: "ADMINISTRATION", en: "Administration", ar: "الادارة" },
    { category: "location", code: "ON_ROAD", en: "On the Road", ar: "على الطريق" },
    { category: "location", code: "MAINTENANCE_WORKSHOPS", en: "Maintenance Workshops", ar: "ورش الصيانة" },
    { category: "location", code: "FOUNDRIES", en: "Foundries", ar: "المسابك" },
    { category: "location", code: "CNC", en: "CNC", ar: "CNC" },
    { category: "location", code: "MOLD_WORKSHOP", en: "Mold Workshop", ar: "ورشة الاسطمبات" },
    { category: "location", code: "OTHER", en: "Other", ar: "اخرى" },
  ];

  const incidentCauses: MD[] = [
    { category: "incident_cause", code: "COLLISION_EQUIPMENT", en: "Collision with Equipment" },
    { category: "incident_cause", code: "CAUGHT_BETWEEN", en: "Caught Between Objects" },
    { category: "incident_cause", code: "FALL_HEIGHT", en: "Falling from Height" },
    { category: "incident_cause", code: "FALLING_OBJECTS", en: "Falling Objects" },
    { category: "incident_cause", code: "ELECTRIC_SHOCK", en: "Electric Shock" },
    { category: "incident_cause", code: "HOT_SURFACE", en: "Contact with Hot Surface" },
    { category: "incident_cause", code: "CHEMICALS", en: "Contact with Chemicals" },
    { category: "incident_cause", code: "RADIATION", en: "Radiation Exposure" },
    { category: "incident_cause", code: "EXPLOSION", en: "Explosion" },
    { category: "incident_cause", code: "ROTATING_PARTS", en: "Exposure to Rotating Parts" },
    { category: "incident_cause", code: "SHARP_OBJECTS", en: "Contact with Sharp Objects" },
    { category: "incident_cause", code: "WORK_ENVIRONMENT", en: "Work Environment" },
    { category: "incident_cause", code: "INFECTION", en: "Infection" },
    { category: "incident_cause", code: "OTHER", en: "Other" },
  ];

  const unsafeActs: MD[] = [
    { category: "unsafe_act", code: "NEGLIGENCE", en: "Negligence" },
    { category: "unsafe_act", code: "LACK_FOCUS", en: "Lack of Focus" },
    { category: "unsafe_act", code: "POOR_EXPERIENCE", en: "Poor Experience" },
    { category: "unsafe_act", code: "RISK_TAKING", en: "Risk-Taking Behavior" },
    { category: "unsafe_act", code: "OVERCONFIDENCE", en: "Overconfidence" },
    { category: "unsafe_act", code: "PSYCHOLOGICAL", en: "Psychological Reasons" },
    { category: "unsafe_act", code: "FAILURE_INSTRUCTIONS", en: "Failure to Follow Instructions" },
    { category: "unsafe_act", code: "NOT_WEARING_PPE", en: "Not Wearing PPE" },
    { category: "unsafe_act", code: "OTHER", en: "Other" },
  ];

  const unsafeConditions: MD[] = [
    { category: "unsafe_condition", code: "LACK_TRAINING", en: "Lack of Training" },
    { category: "unsafe_condition", code: "WEAK_SUPERVISION", en: "Weak Supervision" },
    { category: "unsafe_condition", code: "WEAK_FOLLOWUP", en: "Weak Follow-up" },
    { category: "unsafe_condition", code: "UNCONTROLLED_HAZARDS", en: "Uncontrolled Hazards" },
    { category: "unsafe_condition", code: "YOUNG_AGE", en: "Young Age" },
    { category: "unsafe_condition", code: "LONG_HOURS", en: "Long Working Hours" },
    { category: "unsafe_condition", code: "OLD_AGE", en: "Old Age" },
    { category: "unsafe_condition", code: "JOB_INCOMPATIBILITY", en: "Job Incompatibility" },
    { category: "unsafe_condition", code: "NO_TBT", en: "Failure to Receive TBT" },
    { category: "unsafe_condition", code: "CONFINED_SPACES", en: "Confined Spaces" },
    { category: "unsafe_condition", code: "POOR_SAFETY_PROCEDURES", en: "Poor Safety Procedures" },
    { category: "unsafe_condition", code: "LACK_PPE_PROVISION", en: "Lack of PPE Provision" },
    { category: "unsafe_condition", code: "NO_WTP", en: "Failure to Receive WTP" },
    { category: "unsafe_condition", code: "OTHER", en: "Other" },
  ];

  // Detailed body-part list (F-HSE3-01 Sheet2) mapped to the dashboard's
  // generic bucket list (Monthly report / KPIs calculator), per Conflict
  // resolution instruction #9 in the brief.
  const bodyPartsDetail: MD[] = [
    { category: "body_part_detail", code: "RIGHT_ARM", en: "Right Arm", mapping: "Arm" },
    { category: "body_part_detail", code: "LEFT_ARM", en: "Left Arm", mapping: "Arm" },
    { category: "body_part_detail", code: "RIGHT_LEG", en: "Right Leg", mapping: "Leg" },
    { category: "body_part_detail", code: "LEFT_LEG", en: "Left Leg", mapping: "Leg" },
    { category: "body_part_detail", code: "HEAD", en: "Head", mapping: "Head" },
    { category: "body_part_detail", code: "FACE", en: "Face", mapping: "Head" },
    { category: "body_part_detail", code: "EYE", en: "Eye", mapping: "Eyes" },
    { category: "body_part_detail", code: "TORSO", en: "Torso", mapping: "Chest" },
    { category: "body_part_detail", code: "NECK", en: "Neck", mapping: "Neck" },
    { category: "body_part_detail", code: "SPINE", en: "Spine", mapping: "Back" },
    { category: "body_part_detail", code: "FINGERS", en: "Fingers", mapping: "Fingers" },
    { category: "body_part_detail", code: "OTHER", en: "Other", mapping: "Other" },
  ];

  const bodyPartsDashboard: MD[] = [
    "Head", "Eyes", "Neck", "Chest", "Elbow", "Back", "Feet", "Hands",
    "Knees", "Ankle", "Fingers", "Abdomen", "Arm", "Leg",
  ].map((en, i) => ({
    category: "body_part_dashboard",
    code: en.toUpperCase(),
    en,
    order: i,
  }));

  // Frequency: no fixed list found anywhere in the source workbook —
  // seeded empty/open per Conflict #9; add real values via Master Data admin UI.
  const frequency: MD[] = [
    { category: "frequency", code: "FIRST_TIME", en: "First Time" },
    { category: "frequency", code: "RECURRING", en: "Recurring" },
  ];

  const all = [
    ...incidentLocations,
    ...incidentCauses,
    ...unsafeActs,
    ...unsafeConditions,
    ...bodyPartsDetail,
    ...bodyPartsDashboard,
    ...frequency,
  ];

  for (const [i, m] of all.entries()) {
    await prisma.masterData.upsert({
      where: { category_code: { category: m.category, code: m.code } },
      update: {},
      create: {
        category: m.category,
        code: m.code,
        valueEn: m.en,
        valueAr: m.ar,
        dashboardMapping: m.mapping,
        displayOrder: m.order ?? i,
      },
    });
  }

  // ------------------------------------------------ Environmental coefficients
  // Exact values confirmed in Environmental Data sheet (H3:L3 formulas).
  const coefficients = [
    { gas: "R11", value: 4.66 },
    { gas: "R22", value: 0.176 }, // 1.76 * 10%
    { gas: "R32", value: 0.677 },
    { gas: "R134", value: 0.13 }, // 1.3 * 10%
    { gas: "R410", value: 0.1924 }, // 1.924 * 10%
    { gas: "Diesel", value: 0.0027 }, // 2.7 / 1000 (kg CO2 per liter, expressed per-ton divisor already applied downstream)
    { gas: "Electricity", value: 0.00042 }, // 0.42 / 1000
  ];
  for (const c of coefficients) {
    await prisma.environmentalCoefficient.create({
      data: {
        gas: c.gas,
        coefficientValue: c.value,
        effectiveDate: new Date("2026-01-01"),
      },
    });
  }

  // -------------------------------------------------- Workforce parameters
  // Behaviour required: the normal/default headcount is 3200, but any single
  // month can be changed independently; if a month is never changed it simply
  // stays 3200.
  //
  // Implemented in two layers:
  //   1. SystemSetting default_no_of_workers = 3200 (global fallback — any
  //      month with no row at all, including future years, resolves to this).
  //   2. WorkforceParameter rows per month — created at the default, editable
  //      individually. `update: {}` means re-running the seed NEVER overwrites
  //      a month an administrator has already corrected.
  const DEFAULT_WORKERS = 3200;
  const DEFAULT_SHIFT_HOURS = 8;

  await prisma.systemSetting.upsert({
    where: { key: "default_no_of_workers" },
    update: {},
    create: {
      key: "default_no_of_workers",
      value: String(DEFAULT_WORKERS),
      description:
        "Default headcount used for any month that has no explicit WorkforceParameter row. Matches the legacy workbook constant.",
    },
  });
  await prisma.systemSetting.upsert({
    where: { key: "default_shift_hours" },
    update: {},
    create: {
      key: "default_shift_hours",
      value: String(DEFAULT_SHIFT_HOURS),
      description:
        "Default shift hours used for any month that has no explicit WorkforceParameter row.",
    },
  });

  const SEED_YEARS = [2026];
  for (const year of SEED_YEARS) {
    for (let month = 1; month <= 12; month++) {
      await prisma.workforceParameter.upsert({
        where: { year_month: { year, month } },
        update: {}, // never overwrite a month an admin has already edited
        create: {
          year,
          month,
          noOfWorkers: DEFAULT_WORKERS,
          shiftHours: DEFAULT_SHIFT_HOURS,
          workingDaysOverride: null, // null = calendar days, matching legacy Excel
          changeReason: "Seeded at default headcount (editable per month)",
        },
      });
    }
  }

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
