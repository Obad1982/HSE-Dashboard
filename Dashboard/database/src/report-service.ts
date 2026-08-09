// ============================================================================
// Energya HSE — Report service
// ----------------------------------------------------------------------------
// Report numbering, workflow transitions, audit logging, and the
// create/update paths that keep FAC / LTI / LWDs continuously correct.
//
// Key guarantees:
//   - Report numbers are unique and concurrency-safe under multiple users
//   - FAC / LTI / LWDs are ALWAYS recomputed server-side, never accepted
//     from the client (brief rule #6)
//   - Changing the return-to-work date re-splits the monthly allocation
//   - Cancelled reports leave the KPIs but stay in the audit log (rule #13)
// ============================================================================
import { PrismaClient, Prisma } from "@prisma/client";
import {
  classifyIncident,
  suggestDueDate,
  requiresImmediateAction,
  type ReportSourceValue,
  type RiskLevel,
} from "./hse-calculations";

const prisma = new PrismaClient();

// ----------------------------------------------------------------------------
// Report numbering
// ----------------------------------------------------------------------------

const PREFIX: Record<string, string> = {
  Injury: "INC",
  Near_Miss: "NM",
  Violation: "VIO",
};

/**
 * Generates the next report number for a source and year, e.g. INC-2026-0001.
 *
 * Concurrency: runs inside a transaction and relies on the UNIQUE constraint on
 * reports.report_number. Under a race, the loser's INSERT fails and we retry
 * with a fresh number rather than silently issuing a duplicate. The legacy
 * workbook used a plain sequential "NO" column with no such protection.
 */
export async function generateReportNumber(
  source: keyof typeof PREFIX,
  year: number,
  tx: Prisma.TransactionClient = prisma
): Promise<string> {
  const prefix = PREFIX[source];
  const like = `${prefix}-${year}-%`;

  const last = await tx.report.findFirst({
    where: { reportNumber: { startsWith: `${prefix}-${year}-` } },
    orderBy: { reportNumber: "desc" },
    select: { reportNumber: true },
  });

  const lastSeq = last ? parseInt(last.reportNumber.split("-")[2], 10) : 0;
  return `${prefix}-${year}-${String(lastSeq + 1).padStart(4, "0")}`;
}

const MAX_NUMBER_RETRIES = 5;

/** Runs `fn` with a freshly generated number, retrying on unique-constraint races. */
async function withGeneratedNumber<T>(
  source: keyof typeof PREFIX,
  year: number,
  fn: (reportNumber: string, tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  for (let attempt = 0; attempt < MAX_NUMBER_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const number = await generateReportNumber(source, year, tx);
        return fn(number, tx);
      });
    } catch (err) {
      const isDuplicate =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" &&
        String(err.meta?.target ?? "").includes("report_number");
      if (!isDuplicate || attempt === MAX_NUMBER_RETRIES - 1) throw err;
      // another user took this number — loop and try the next one
    }
  }
  throw new Error("Could not allocate a unique report number");
}

// ----------------------------------------------------------------------------
// Audit logging
// ----------------------------------------------------------------------------

export async function writeAudit(
  tx: Prisma.TransactionClient,
  entry: {
    userId?: number | null;
    reportId?: number | null;
    action: string;
    fieldName?: string;
    oldValue?: string | null;
    newValue?: string | null;
    ipAddress?: string | null;
  }
) {
  await tx.auditLog.create({
    data: {
      userId: entry.userId ?? null,
      reportId: entry.reportId ?? null,
      action: entry.action,
      fieldName: entry.fieldName,
      oldValue: entry.oldValue ?? null,
      newValue: entry.newValue ?? null,
      ipAddress: entry.ipAddress ?? null,
    },
  });
}

/** Diffs two objects and writes one audit row per changed field. */
async function auditFieldChanges(
  tx: Prisma.TransactionClient,
  reportId: number,
  userId: number | null | undefined,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  ipAddress?: string | null
) {
  for (const key of Object.keys(after)) {
    const o = before[key];
    const n = after[key];
    const oStr = o instanceof Date ? o.toISOString().slice(0, 10) : o == null ? null : String(o);
    const nStr = n instanceof Date ? n.toISOString().slice(0, 10) : n == null ? null : String(n);
    if (oStr !== nStr) {
      await writeAudit(tx, {
        userId, reportId, action: "field_updated",
        fieldName: key, oldValue: oStr, newValue: nStr, ipAddress,
      });
    }
  }
}

// ----------------------------------------------------------------------------
// Incident create / update — always recomputes the derived fields
// ----------------------------------------------------------------------------

export interface IncidentInput {
  reportDate: Date;
  reportTime?: Date | null;
  description: string;
  departmentId?: number | null;
  locationId?: number | null;
  reportedById?: number | null;
  injuredPersonId?: number | null;
  incidentCategory?: string | null;
  damageCategory?: string | null;
  hiringDate?: Date | null;
  returnToWorkDate?: Date | null;
  injuredBodyPartDetailId?: number | null;
  injuredBodyPartDashboardId?: number | null;
  shift?: "Day" | "Night" | null;
  injuryCategory?: string | null;
  attachmentAvailable?: boolean;
  fatality?: boolean;
  witnesses?: { name: string; employeeNumber?: string }[];
}

/**
 * Recomputes FAC / LTI / LWDs and rewrites the monthly allocation rows.
 * Called on every create and every update — this is what makes
 * "change the return date and the classification flips automatically" work.
 */
async function applyClassification(
  tx: Prisma.TransactionClient,
  reportId: number,
  source: ReportSourceValue,
  incidentDate: Date,
  returnToWorkDate: Date | null | undefined,
  fatality: boolean
) {
  const c = classifyIncident({ source, incidentDate, returnToWorkDate, isFatality: fatality });

  await tx.incidentReport.update({
    where: { reportId },
    data: {
      fac: c.fac,
      lti: c.lti,
      totalLostWorkdays: c.totalLostWorkdays,
      injurySeverityComputed: c.severity as any,
    },
  });

  // Replace allocations wholesale — simplest correct behaviour when dates move
  await tx.lostWorkdayAllocation.deleteMany({ where: { incidentReportId: reportId } });
  if (c.allocations.length) {
    await tx.lostWorkdayAllocation.createMany({
      data: c.allocations.map((a) => ({
        incidentReportId: reportId,
        year: a.year,
        month: a.month,
        lostWorkdays: a.lostWorkdays,
      })),
    });
  }
  return c;
}

export async function createIncidentReport(input: IncidentInput, userId: number) {
  const year = input.reportDate.getUTCFullYear();

  return withGeneratedNumber("Injury", year, async (reportNumber, tx) => {
    const report = await tx.report.create({
      data: {
        reportNumber,
        source: "Injury",
        reportType: "Incident",
        reportDate: input.reportDate,
        reportTime: input.reportTime ?? null,
        departmentId: input.departmentId ?? null,
        locationId: input.locationId ?? null,
        reportedById: input.reportedById ?? null,
        description: input.description,
        workflowStatus: "Draft",
        createdById: userId,
        updatedById: userId,
        incidentReport: {
          create: {
            injuredPersonId: input.injuredPersonId ?? null,
            incidentCategory: (input.incidentCategory ?? null) as any,
            damageCategory: (input.damageCategory ?? null) as any,
            hiringDate: input.hiringDate ?? null,
            returnToWorkDate: input.returnToWorkDate ?? null,
            injuredBodyPartDetailId: input.injuredBodyPartDetailId ?? null,
            injuredBodyPartDashboardId: input.injuredBodyPartDashboardId ?? null,
            shift: (input.shift ?? null) as any,
            injuryCategory: input.injuryCategory ?? null,
            attachmentAvailable: input.attachmentAvailable ?? false,
            fatality: input.fatality ?? false,
          },
        },
        ...(input.witnesses?.length
          ? {
              witnesses: {
                create: input.witnesses.map((w) => ({
                  witnessName: w.name,
                  witnessEmployeeNumber: w.employeeNumber,
                })),
              },
            }
          : {}),
      },
    });

    const c = await applyClassification(
      tx, report.id, "Injury", input.reportDate,
      input.returnToWorkDate, input.fatality ?? false
    );

    await writeAudit(tx, {
      userId, reportId: report.id, action: "report_created",
      newValue: `${reportNumber} | FAC=${c.fac} LTI=${c.lti} LWDs=${c.totalLostWorkdays}`,
    });

    return { ...report, classification: c };
  });
}

export async function updateIncidentReport(
  reportId: number,
  input: Partial<IncidentInput>,
  userId: number,
  ipAddress?: string
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.report.findUniqueOrThrow({
      where: { id: reportId },
      include: { incidentReport: true },
    });
    if (!existing.incidentReport) throw new Error("Not an incident report");

    const before = {
      reportDate: existing.reportDate,
      returnToWorkDate: existing.incidentReport.returnToWorkDate,
      departmentId: existing.departmentId,
      fac: existing.incidentReport.fac,
      lti: existing.incidentReport.lti,
      totalLostWorkdays: existing.incidentReport.totalLostWorkdays,
    };

    await tx.report.update({
      where: { id: reportId },
      data: {
        ...(input.reportDate ? { reportDate: input.reportDate } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
        ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
        updatedById: userId,
      },
    });

    await tx.incidentReport.update({
      where: { reportId },
      data: {
        ...(input.returnToWorkDate !== undefined
          ? { returnToWorkDate: input.returnToWorkDate }
          : {}),
        ...(input.injuredBodyPartDetailId !== undefined
          ? { injuredBodyPartDetailId: input.injuredBodyPartDetailId }
          : {}),
        ...(input.injuredBodyPartDashboardId !== undefined
          ? { injuredBodyPartDashboardId: input.injuredBodyPartDashboardId }
          : {}),
        ...(input.shift !== undefined ? { shift: input.shift as any } : {}),
        ...(input.injuryCategory !== undefined ? { injuryCategory: input.injuryCategory } : {}),
        ...(input.fatality !== undefined ? { fatality: input.fatality } : {}),
      },
    });

    // Recompute against the NEW values
    const incidentDate = input.reportDate ?? existing.reportDate;
    const returnDate =
      input.returnToWorkDate !== undefined
        ? input.returnToWorkDate
        : existing.incidentReport.returnToWorkDate;
    const fatality = input.fatality ?? existing.incidentReport.fatality;

    const c = await applyClassification(
      tx, reportId, "Injury", incidentDate, returnDate, fatality
    );

    await auditFieldChanges(tx, reportId, userId, before, {
      reportDate: incidentDate,
      returnToWorkDate: returnDate,
      departmentId: input.departmentId ?? existing.departmentId,
      fac: c.fac,
      lti: c.lti,
      totalLostWorkdays: c.totalLostWorkdays,
    }, ipAddress);

    // A FAC↔LTI flip is significant enough to log on its own
    if (before.fac !== c.fac || before.lti !== c.lti) {
      await writeAudit(tx, {
        userId, reportId, action: "classification_changed",
        oldValue: `FAC=${before.fac} LTI=${before.lti} LWDs=${before.totalLostWorkdays}`,
        newValue: `FAC=${c.fac} LTI=${c.lti} LWDs=${c.totalLostWorkdays}`,
        ipAddress,
      });
    }

    return c;
  });
}

// ----------------------------------------------------------------------------
// Violation / Near Miss
// ----------------------------------------------------------------------------

export interface VnmInput {
  type: "Violation" | "Near Miss";
  reportDate: Date;
  reportTime?: Date | null;
  summary: string;
  departmentId?: number | null;
  locationId?: number | null;
  reportedById?: number | null;
  unsafeAction: boolean;
  unsafeCondition: boolean;
  frequencyId?: number | null;
  frequencyCount?: number | null;
  impactEnvironment?: boolean;
  impactHealth?: boolean;
  impactPersonnelSafety?: boolean;
  impactEquipmentFacility?: boolean;
  riskClassification: RiskLevel;
  immediateActionTaken?: string | null;
  dueDate?: Date | null;
  correctiveActions?: {
    description: string;
    responsibleUserId?: number;
    responsibleDepartmentId?: number;
    targetDate?: Date;
  }[];
}

export async function createVnmReport(input: VnmInput, userId: number) {
  const year = input.reportDate.getUTCFullYear();
  const source = input.type === "Near Miss" ? "Near_Miss" : "Violation";

  // Due date auto-suggested from risk, overridable by an authorized user
  const dueDate = input.dueDate ?? suggestDueDate(input.riskClassification, input.reportDate);

  return withGeneratedNumber(source, year, async (reportNumber, tx) => {
    const report = await tx.report.create({
      data: {
        reportNumber,
        source: source as any,
        reportType: input.type === "Near Miss" ? "NearMiss" : "Violation",
        reportDate: input.reportDate,
        reportTime: input.reportTime ?? null,
        departmentId: input.departmentId ?? null,
        locationId: input.locationId ?? null,
        reportedById: input.reportedById ?? null,
        description: input.summary,
        workflowStatus: requiresImmediateAction(input.riskClassification)
          ? "Immediate_Action_Required"
          : "Draft",
        createdById: userId,
        updatedById: userId,
        violationNearMiss: {
          create: {
            unsafeAction: input.unsafeAction,
            unsafeCondition: input.unsafeCondition,
            frequencyId: input.frequencyId ?? null,
            frequencyCount: input.frequencyCount ?? null,
            impactEnvironment: input.impactEnvironment ?? false,
            impactHealth: input.impactHealth ?? false,
            impactPersonnelSafety: input.impactPersonnelSafety ?? false,
            impactEquipmentFacility: input.impactEquipmentFacility ?? false,
            riskClassification: input.riskClassification as any,
            immediateActionRequired: requiresImmediateAction(input.riskClassification),
            immediateActionTaken: input.immediateActionTaken ?? null,
            dueDate,
          },
        },
        ...(input.correctiveActions?.length
          ? {
              correctiveActions: {
                create: input.correctiveActions.map((a, i) => ({
                  actionNumber: i + 1,
                  actionDescription: a.description,
                  responsibleUserId: a.responsibleUserId ?? null,
                  responsibleDepartmentId: a.responsibleDepartmentId ?? null,
                  targetDate: a.targetDate ?? dueDate,
                  actionStatus: "Draft",
                })),
              },
            }
          : {}),
      },
    });

    await writeAudit(tx, {
      userId, reportId: report.id, action: "report_created",
      newValue: `${reportNumber} | risk=${input.riskClassification} due=${dueDate?.toISOString().slice(0,10) ?? "manual"}`,
    });

    return report;
  });
}

// ----------------------------------------------------------------------------
// Workflow
// ----------------------------------------------------------------------------

const INCIDENT_TRANSITIONS: Record<string, string[]> = {
  Draft: ["Submitted", "Cancelled"],
  Submitted: ["Under_Review", "Returned_for_Correction", "Cancelled"],
  Under_Review: ["Analysis_in_Progress", "Returned_for_Correction", "Cancelled"],
  Returned_for_Correction: ["Submitted", "Cancelled"],
  Analysis_in_Progress: ["Pending_HSE_Manager_Approval", "Cancelled"],
  Pending_HSE_Manager_Approval: ["Approved", "Returned_for_Correction", "Cancelled"],
  Approved: ["Corrective_Actions_in_Progress", "Closed", "Cancelled"],
  Corrective_Actions_in_Progress: ["Pending_Verification", "Cancelled"],
  Pending_Verification: ["Closed", "Corrective_Actions_in_Progress", "Cancelled"],
  Closed: ["Reopened"],
  Reopened: ["Corrective_Actions_in_Progress", "Under_Review", "Cancelled"],
  Cancelled: [],
};

const VNM_TRANSITIONS: Record<string, string[]> = {
  Draft: ["Submitted", "Immediate_Action_Required", "Cancelled"],
  Immediate_Action_Required: ["Submitted", "Under_Review", "Cancelled"],
  Submitted: ["Under_Review", "Cancelled"],
  Under_Review: ["Action_Assigned", "Cancelled"],
  Action_Assigned: ["Action_in_Progress", "Cancelled"],
  Action_in_Progress: ["Pending_Verification", "Cancelled"],
  Pending_Verification: ["Done", "Action_in_Progress", "Cancelled"],
  Done: ["Closed", "Reopened"],
  Closed: ["Reopened"],
  Reopened: ["Action_in_Progress", "Cancelled"],
  Cancelled: [],
};

export class WorkflowError extends Error {}

export async function transitionReport(
  reportId: number,
  nextStatus: string,
  userId: number,
  options: { comment?: string; ipAddress?: string } = {}
) {
  return prisma.$transaction(async (tx) => {
    const report = await tx.report.findUniqueOrThrow({
      where: { id: reportId },
      include: { violationNearMiss: true, correctiveActions: true },
    });

    const map = report.reportType === "Incident" ? INCIDENT_TRANSITIONS : VNM_TRANSITIONS;
    const allowed = map[report.workflowStatus] ?? [];
    if (!allowed.includes(nextStatus)) {
      throw new WorkflowError(
        `Cannot move from "${report.workflowStatus}" to "${nextStatus}". Allowed: ${allowed.join(", ") || "none"}`
      );
    }

    // Very High Risk cannot be closed without a recorded immediate action
    const closing = ["Closed", "Done"].includes(nextStatus);
    const vnm = report.violationNearMiss;
    if (closing && vnm?.immediateActionRequired && !vnm.immediateActionTaken?.trim()) {
      throw new WorkflowError(
        "This report is classified Very High Risk — an immediate action must be recorded before it can be closed."
      );
    }

    // Closing requires every corrective action to be finished
    if (closing) {
      const open = report.correctiveActions.filter(
        (a) => !["Done", "Closed", "Cancelled"].includes(a.actionStatus)
      );
      if (open.length) {
        throw new WorkflowError(
          `${open.length} corrective action(s) are still open. Complete or cancel them before closing.`
        );
      }
    }

    await tx.report.update({
      where: { id: reportId },
      data: {
        workflowStatus: nextStatus,
        updatedById: userId,
        ...(nextStatus === "Cancelled"
          ? { cancelledReason: options.comment ?? null, deletedAt: new Date() }
          : {}),
        ...(report.workflowStatus === "Cancelled" && nextStatus !== "Cancelled"
          ? { deletedAt: null }
          : {}),
      },
    });

    await writeAudit(tx, {
      userId, reportId, action: `status_${nextStatus.toLowerCase()}`,
      fieldName: "workflowStatus",
      oldValue: report.workflowStatus, newValue: nextStatus,
      ipAddress: options.ipAddress,
    });

    return { from: report.workflowStatus, to: nextStatus };
  });
}

// ----------------------------------------------------------------------------
// Corrective actions
// ----------------------------------------------------------------------------

export async function updateActionStatus(
  actionId: number,
  status: string,
  userId: number,
  options: { completionDate?: Date; verificationNotes?: string; ipAddress?: string } = {}
) {
  return prisma.$transaction(async (tx) => {
    const action = await tx.correctiveAction.findUniqueOrThrow({ where: { id: actionId } });

    await tx.correctiveAction.update({
      where: { id: actionId },
      data: {
        actionStatus: status as any,
        ...(status === "Done" ? { completionDate: options.completionDate ?? new Date() } : {}),
        ...(options.verificationNotes ? { verificationNotes: options.verificationNotes } : {}),
        ...(status === "Closed" ? { verifiedById: userId, verifiedAt: new Date() } : {}),
      },
    });

    await writeAudit(tx, {
      userId, reportId: action.reportId, action: "action_status_changed",
      fieldName: `correctiveAction#${action.actionNumber}`,
      oldValue: action.actionStatus, newValue: status,
      ipAddress: options.ipAddress,
    });
  });
}

/** Overdue = past its target date and not finished. Drives the list indicator. */
export async function getOverdueActions() {
  return prisma.correctiveAction.findMany({
    where: {
      targetDate: { lt: new Date() },
      actionStatus: { notIn: ["Done", "Closed", "Cancelled"] },
      report: { deletedAt: null, workflowStatus: { not: "Cancelled" } },
    },
    include: {
      report: { select: { reportNumber: true, source: true, reportDate: true } },
      responsibleUser: { select: { fullName: true, email: true } },
      responsibleDepartment: { select: { departmentNameEn: true } },
    },
    orderBy: { targetDate: "asc" },
  });
}

// ----------------------------------------------------------------------------
// Notifications
// ----------------------------------------------------------------------------

export async function notify(
  tx: Prisma.TransactionClient,
  userIds: number[],
  type: string,
  message: string,
  reportId?: number
) {
  if (!userIds.length) return;
  await tx.notification.createMany({
    data: userIds.map((userId) => ({ userId, type, message, reportId: reportId ?? null })),
  });
}
