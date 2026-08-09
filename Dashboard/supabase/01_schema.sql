-- =====================================================================
--  Energya HSE  —  Near Miss & Violation reporting backend
--  Run this ONCE in  Supabase → SQL Editor → New query → Run
-- =====================================================================
--  Design notes
--   * Values that already exist in the Excel Action_plan sheet are kept
--     VERBATIM (including the space in 'Un safe condition' and the
--     misspellings 'Maintinance' / 'Plastring').  Changing them would
--     split the historical statistics in the dashboard.
--   * The form is a PUBLIC link, so the tables are NOT writable directly.
--     Everything goes through submit_hse_report(), which validates the
--     payload and allocates the report number atomically.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------------ 1
-- master lists  (System Administrator can edit these later)
-- ------------------------------------------------------------------
create table if not exists hse_master (
  id            bigint generated always as identity primary key,
  category      text not null,          -- 'department' | 'reported_by' | ...
  value         text not null,          -- stored EXACTLY as the dashboard expects
  label_ar      text,
  display_order int  not null default 0,
  active        boolean not null default true,
  unique (category, value)
);

insert into hse_master (category, value, label_ar, display_order) values
  ('department','Tower',      'الأبراج',        1),
  ('department','Steel',      'الصلب',          2),
  ('department','Plate',      'الألواح',        3),
  ('department','Poles',      'الأعمدة',        4),
  ('department','Galvanizing','الجلفنة',        5),
  ('department','Painting',   'الدهانات',       6),
  ('department','WH',         'المخازن',        7),
  ('department','Dispatch',   'الشحن',          8),
  ('department','Maintinance','الصيانة',        9),
  ('department','Plastring',  'المسابك',       10)
on conflict (category, value) do nothing;

insert into hse_master (category, value, display_order) values
  ('reported_by','Mohamed Yousry',1),  ('reported_by','Ahmed Salah',2),
  ('reported_by','Kamal Esawy',3),     ('reported_by','Mahmoud Ramadan',4),
  ('reported_by','Turki Elaslany',5),  ('reported_by','Mahmoud Saeid',6),
  ('reported_by','Magdi Abdelghany',7),('reported_by','Ahmed Nasheat',8),
  ('reported_by','Mohamed Elharby',9), ('reported_by','Osman Elsayed',10),
  ('reported_by','Abdullah Elblady',11),('reported_by','Haider Karam',12),
  ('reported_by','Amjed Ali',13),      ('reported_by','Ahmed Haider',14),
  ('reported_by','Ayed ElRayqy',15),   ('reported_by','Omar ElQraqry',16),
  ('reported_by','Sujjad Hedaya',17),  ('reported_by','Fayez Elbeshry',18),
  ('reported_by','Mahmoud Saed',19)
on conflict (category, value) do nothing;

-- ------------------------------------------------------------------ 2
-- reports
-- ------------------------------------------------------------------
create table if not exists hse_reports (
  id              uuid primary key default gen_random_uuid(),
  report_number   text unique not null,          -- VIO-2026-0001 / NM-2026-0001
  seq_year        int  not null,
  seq_no          int  not null,

  -- ---- fields that feed Action_plan directly (names match the dashboard) ----
  source          text not null check (source in ('Violation','Near Miss')),
  cause           text not null check (cause  in ('Un safe condition','Un safe action')),
  department      text not null,
  report_date     date not null,
  description     text not null,                 -- ملخص المخالفة  -> وصف الحدث
  responsible     text,                          -- المسئول (free text, Arabic)
  execution_date  date,                          -- تاريخ التنفيذ / Due Date
  status          text not null default 'Not Done'
                    check (status in ('Done','Not Done')),
  reported_by     text not null,                 -- جهة الإبلاغ

  -- ---- violation-specific fields (printed, not in Action_plan) ----
  report_time     time,
  frequency       text,
  impact_environment          boolean not null default false,
  impact_health               boolean not null default false,
  impact_personnel_safety     boolean not null default false,
  impact_equipment_facility   boolean not null default false,
  risk_classification text check (risk_classification in
                    ('Very High Risk','High Risk','Moderate Risk','Low Risk')),
  immediate_action    text,                      -- required for Very High Risk
  hse_officer         text,
  dept_supervisor     text,

  -- ---- housekeeping ----
  workflow_status text not null default 'Submitted',
  cancelled       boolean not null default false,
  edit_token      uuid not null default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  client_info     text
);

create index if not exists hse_reports_date_idx   on hse_reports (report_date);
create index if not exists hse_reports_source_idx on hse_reports (source);

-- ------------------------------------------------------------------ 3
-- corrective actions  (unlimited per report; the print view shows 4/page)
-- ------------------------------------------------------------------
create table if not exists hse_corrective_actions (
  id            uuid primary key default gen_random_uuid(),
  report_id     uuid not null references hse_reports(id) on delete cascade,
  action_number int  not null,
  description   text not null,
  responsible   text,
  due_date      date,
  status        text not null default 'Not Done'
                  check (status in ('Done','Not Done')),
  completion_date date,
  created_at    timestamptz not null default now(),
  unique (report_id, action_number)
);

-- ------------------------------------------------------------------ 4
-- audit log
-- ------------------------------------------------------------------
create table if not exists hse_audit (
  id         bigint generated always as identity primary key,
  report_id  uuid,
  action     text not null,
  detail     jsonb,
  at         timestamptz not null default now()
);

-- ------------------------------------------------------------------ 5
-- Action_plan view  —  exactly the shape the dashboard already understands
-- ------------------------------------------------------------------
create or replace view action_plan_view as
select
  r.report_number,
  r.description                       as description,
  r.cause                             as cause,
  r.source                            as source,
  r.department                        as department,
  to_char(r.report_date,'YYYY-MM-DD') as date,
  null::text                          as nationality,
  coalesce(
    (select string_agg(a.action_number || ') ' || a.description, E'\n'
                       order by a.action_number)
       from hse_corrective_actions a where a.report_id = r.id),
    '')                               as "correctiveAction",
  r.responsible                       as responsible,
  to_char(r.execution_date,'YYYY-MM-DD') as "executionDate",
  r.status                            as status,
  r.reported_by                       as "reportedBy",
  null::text                          as "returnDate",
  null::text                          as "injuredPart",
  null::text                          as shift,
  null::text                          as category,
  r.risk_classification,
  r.created_at
from hse_reports r
where r.cancelled = false
order by r.report_date, r.created_at;

-- ------------------------------------------------------------------ 6
-- atomic submit  (the ONLY write path open to the public form)
-- ------------------------------------------------------------------
create or replace function submit_hse_report(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source  text := payload->>'source';
  v_year    int  := extract(year from (payload->>'report_date')::date);
  v_prefix  text;
  v_seq     int;
  v_number  text;
  v_id      uuid;
  v_act     jsonb;
  v_risk    text := nullif(payload->>'risk_classification','');
  v_n       int  := 0;
begin
  if v_source not in ('Violation','Near Miss') then
    raise exception 'invalid source';
  end if;

  -- Very High Risk cannot be filed without recording the immediate action
  if v_risk = 'Very High Risk'
     and coalesce(trim(payload->>'immediate_action'),'') = '' then
    raise exception 'immediate action is required for Very High Risk';
  end if;

  v_prefix := case when v_source = 'Violation' then 'VIO' else 'NM' end;

  -- allocate the next number for this prefix+year under a lock so that two
  -- officers submitting at the same second can never collide
  perform pg_advisory_xact_lock(hashtext(v_prefix || v_year::text));
  select coalesce(max(seq_no),0) + 1 into v_seq
    from hse_reports
   where seq_year = v_year
     and report_number like v_prefix || '-%';

  v_number := v_prefix || '-' || v_year || '-' || lpad(v_seq::text, 4, '0');

  insert into hse_reports (
    report_number, seq_year, seq_no, source, cause, department, report_date,
    description, responsible, execution_date, status, reported_by,
    report_time, frequency,
    impact_environment, impact_health,
    impact_personnel_safety, impact_equipment_facility,
    risk_classification, immediate_action, hse_officer, dept_supervisor,
    client_info)
  values (
    v_number, v_year, v_seq, v_source,
    payload->>'cause',
    payload->>'department',
    (payload->>'report_date')::date,
    trim(payload->>'description'),
    nullif(trim(coalesce(payload->>'responsible','')),''),
    nullif(payload->>'execution_date','')::date,
    coalesce(payload->>'status','Not Done'),
    payload->>'reported_by',
    nullif(payload->>'report_time','')::time,
    nullif(trim(coalesce(payload->>'frequency','')),''),
    coalesce((payload->>'impact_environment')::boolean,false),
    coalesce((payload->>'impact_health')::boolean,false),
    coalesce((payload->>'impact_personnel_safety')::boolean,false),
    coalesce((payload->>'impact_equipment_facility')::boolean,false),
    v_risk,
    nullif(trim(coalesce(payload->>'immediate_action','')),''),
    nullif(trim(coalesce(payload->>'hse_officer','')),''),
    nullif(trim(coalesce(payload->>'dept_supervisor','')),''),
    nullif(payload->>'client_info',''))
  returning id into v_id;

  for v_act in select * from jsonb_array_elements(coalesce(payload->'actions','[]'::jsonb))
  loop
    if coalesce(trim(v_act->>'description'),'') <> '' then
      v_n := v_n + 1;
      insert into hse_corrective_actions
        (report_id, action_number, description, responsible, due_date, status)
      values (v_id, v_n, trim(v_act->>'description'),
              nullif(trim(coalesce(v_act->>'responsible','')),''),
              nullif(v_act->>'due_date','')::date,
              coalesce(v_act->>'status','Not Done'));
    end if;
  end loop;

  insert into hse_audit (report_id, action, detail)
  values (v_id, 'submitted', jsonb_build_object('report_number', v_number));

  return jsonb_build_object(
           'report_number', v_number,
           'id',            v_id,
           'edit_token',    (select edit_token from hse_reports where id = v_id));
end $$;

-- ------------------------------------------------------------------ 7
-- follow-up update  (officer closing his own action, using the edit token)
-- ------------------------------------------------------------------
create or replace function update_hse_followup(
  p_report_number text, p_edit_token uuid, p_status text,
  p_execution_date text, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_id uuid; v_old text;
begin
  select id, status into v_id, v_old
    from hse_reports
   where report_number = p_report_number and edit_token = p_edit_token;
  if v_id is null then raise exception 'report not found or token invalid'; end if;
  if p_status not in ('Done','Not Done') then raise exception 'invalid status'; end if;

  update hse_reports
     set status         = p_status,
         execution_date = nullif(p_execution_date,'')::date,
         updated_at     = now()
   where id = v_id;

  insert into hse_audit (report_id, action, detail)
  values (v_id,'status_changed',
          jsonb_build_object('from',v_old,'to',p_status,'note',p_note));

  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------------ 8
-- Row Level Security
-- ------------------------------------------------------------------
alter table hse_reports            enable row level security;
alter table hse_corrective_actions enable row level security;
alter table hse_audit              enable row level security;
alter table hse_master             enable row level security;

-- no direct INSERT/UPDATE/DELETE policies are created on purpose:
-- with RLS on and no policy, anon can do nothing directly.

-- the dashboard needs to READ the reports
drop policy if exists read_reports on hse_reports;
create policy read_reports on hse_reports
  for select to anon, authenticated using (true);

drop policy if exists read_actions on hse_corrective_actions;
create policy read_actions on hse_corrective_actions
  for select to anon, authenticated using (true);

-- the form needs to READ the master lists
drop policy if exists read_master on hse_master;
create policy read_master on hse_master
  for select to anon, authenticated using (active);

-- writing is only possible through the two functions above
grant execute on function submit_hse_report(jsonb)                       to anon, authenticated;
grant execute on function update_hse_followup(text, uuid, text, text, text) to anon, authenticated;
grant select on action_plan_view to anon, authenticated;

-- =====================================================================
--  done.  Project Settings -> API  gives you the URL + anon key
--  to paste into the HTML form and the dashboard.
-- =====================================================================
