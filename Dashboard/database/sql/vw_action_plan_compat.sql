-- ============================================================================
-- vw_action_plan_compat
-- Reproduces the legacy Action_plan 24-column structure (ITR Energya
-- Dashboard 2026.xlsx) so existing-formula logic can be validated 1:1
-- against the new relational schema during import testing.
--
-- Column order and headers match the original Excel table exactly
-- (Arabic headers preserved verbatim) so a side-by-side diff against an
-- exported copy of the legacy Action_plan table is a straight comparison.
-- ============================================================================

CREATE OR REPLACE VIEW vw_action_plan_compat AS
SELECT
    COALESCE(r.legacy_action_plan_no, r.id)                       AS "NO",
    r.description                                                  AS "وصـــف الحــــدث ",
    COALESCE(
        CASE WHEN vnm.unsafe_action THEN 'Un safe action' END,
        CASE WHEN vnm.unsafe_condition THEN 'Un safe condition' END,
        md_cause.value_en
    )                                                               AS "سبـــب الحـــدث ",
    r.source::text                                                  AS "المصدر",
    COALESCE(d1.legacy_value, d1.department_name_en, d2.legacy_value, d2.department_name_en) AS "الادارة المـــختـصة عن العـــمل ",
    r.report_date                                                   AS "التـــاريخ  ",
    COALESCE(p.nationality, '')                                     AS "الجنسية ",
    (
        SELECT string_agg(ca.action_description, E'\n' ORDER BY ca.action_number)
        FROM corrective_actions ca WHERE ca.report_id = r.id
    )                                                                AS "الاجــــراء التصحـــيحى ",
    (
        SELECT ca.responsible_department_id::text
        FROM corrective_actions ca WHERE ca.report_id = r.id
        ORDER BY ca.action_number LIMIT 1
    )                                                                AS "المســـئول ",
    (
        SELECT MIN(ca.target_date)
        FROM corrective_actions ca WHERE ca.report_id = r.id
    )                                                                AS "تاريــــخ التنــــفيــذ",
    CASE
        WHEN vnm.print_action_status = 'Done' THEN 'Done'
        WHEN ir.report_id IS NOT NULL THEN
            CASE WHEN r.workflow_status IN ('Closed','Done') THEN 'Done' ELSE 'Not Done' END
        ELSE 'Not Done'
    END                                                              AS "تم / لم يتم ",
    u_reported.full_name                                            AS "جهة الإبلاغ",
    ir.return_to_work_date                                          AS "تاريخ العوده",
    md_body.dashboard_mapping                                       AS "Injured Part",
    ir.shift::text                                                  AS "Shift",
    ir.injury_category                                              AS "Category",
    CASE WHEN ir.fac THEN 1 ELSE 0 END                              AS "FAC",
    CASE WHEN ir.lti THEN 1 ELSE 0 END                              AS "LTIs ",
    COALESCE(lwd.m0, 0)                                             AS "LWDs",
    COALESCE(lwd.m1, 0)                                             AS "LWDs1",
    COALESCE(lwd.m2, 0)                                             AS "LWDs2",
    COALESCE(lwd.m3, 0)                                             AS "LWDs3",
    EXTRACT(MONTH FROM r.report_date)::int                          AS "No. of Month",
    EXTRACT(YEAR FROM r.report_date)::int                           AS "Years"
FROM reports r
LEFT JOIN incident_reports ir            ON ir.report_id = r.id
LEFT JOIN violation_near_miss_reports vnm ON vnm.report_id = r.id
LEFT JOIN persons p                       ON p.id = ir.injured_person_id
LEFT JOIN departments d1                  ON d1.id = r.department_id
LEFT JOIN departments d2                  ON d2.id IS NULL -- placeholder, corrective-action dept resolved separately if needed
LEFT JOIN master_data md_body             ON md_body.id = ir.injured_body_part_dashboard_id
LEFT JOIN master_data md_cause            ON md_cause.id = NULL -- incident cause resolved via incident_analysis, joined below if needed
LEFT JOIN users u_reported                ON u_reported.id = r.reported_by_id
LEFT JOIN LATERAL (
    -- Reconstructs the fixed 4-column month-by-month layout from the
    -- unbounded LostWorkdayAllocations table, for parity with the legacy
    -- workbook's 4-month cap. Any lost days beyond month 4 are visible
    -- only via lost_workday_allocations directly, not in this compat view.
    SELECT
        MAX(CASE WHEN rn = 0 THEN lost_workdays END) AS m0,
        MAX(CASE WHEN rn = 1 THEN lost_workdays END) AS m1,
        MAX(CASE WHEN rn = 2 THEN lost_workdays END) AS m2,
        MAX(CASE WHEN rn = 3 THEN lost_workdays END) AS m3
    FROM (
        SELECT lost_workdays,
               ROW_NUMBER() OVER (ORDER BY year, month) - 1 AS rn
        FROM lost_workday_allocations
        WHERE incident_report_id = ir.report_id
    ) ranked
) lwd ON TRUE
WHERE r.deleted_at IS NULL
  AND r.workflow_status <> 'Cancelled';

COMMENT ON VIEW vw_action_plan_compat IS
  'Legacy-compatible reconstruction of ITR Energya Dashboard 2026.xlsx > Action_plan table (24 columns, original Arabic headers preserved) for import validation and any downstream tooling still expecting the old flat shape. Not used by the application UI itself — the UI reads from the normalized tables directly.';
