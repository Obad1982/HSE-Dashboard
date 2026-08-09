-- =====================================================================
--  Energya HSE  —  Incident Report & Analysis  (F-HSE3-01)
--  Run this AFTER 01_schema.sql in the Supabase SQL editor.
--
--  It adds the incident tables, the atomic submit function used by
--  "Incident Report.html", and it REPLACES action_plan_view so that the
--  dashboard sees violations, near misses AND incidents in one register
--  with exactly the columns Action_plan already uses.
-- =====================================================================

-- ------------------------------------------------------------------ 1
-- incidents
-- ------------------------------------------------------------------
create table if not exists hse_incidents (
  id            uuid primary key default gen_random_uuid(),
  report_number text unique not null,             -- INC-2026-0001
  seq_year      int  not null,
  seq_no        int  not null,

  -- ---- Sheet 1 : the incident ----
  incident_date date not null,
  incident_time time,
  person_name   text,
  affiliation   text check (affiliation in
                  ('Energya','Agwaa','External Contractor','Visitor')),
  hiring_date   date,
  has_injury    boolean not null default false,
  injury_no     int,
  injury_type   text,                             -- First Aid Case / Minor / …
  has_damage    boolean not null default false,
  damage_no     int,
  damage_types  text[]  not null default '{}',
  description   text not null,
  attachment    text check (attachment in ('Yes','No')),
  witnesses     text[]  not null default '{}',
  dept_manager  text,

  -- ---- Sheet 2 : the analysis ----
  incident_location   text,
  incident_cause      text,
  injured_part_detail text,                       -- Right Arm / Left Arm / …
  unsafe_act          text[] not null default '{}',
  unsafe_condition    text[] not null default '{}',
  direct_causes       text,
  indirect_causes     text,
  root_causes         text,
  corrective_action   text,
  analyst             text,
  analysis_date       date,
  hse_manager         text,

  -- ---- what the dashboard needs ----
  source        text not null default 'Injury'
                  check (source in ('Injury','Near Miss','Violation')),
  department    text not null,
  nationality   text,
  shift         text check (shift in ('Day','Night')),
  category      text,                             -- Contusion / Cut / …
  injured_part  text,                             -- dashboard grouping: Arm, Leg…
  return_date   date,
  responsible   text,
  execution_date date,
  status        text not null default 'Not Done'
                  check (status in ('Done','Not Done')),
  reported_by   text not null,

  workflow_status text not null default 'Submitted',
  cancelled     boolean not null default false,
  edit_token    uuid not null default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  client_info   text,

  -- the return date can never precede the incident
  constraint return_after_incident
    check (return_date is null or return_date >= incident_date)
);

create index if not exists hse_incidents_date_idx on hse_incidents (incident_date);

-- corrective actions attached to an incident (unlimited)
create table if not exists hse_incident_actions (
  id            uuid primary key default gen_random_uuid(),
  incident_id   uuid not null references hse_incidents(id) on delete cascade,
  action_number int  not null,
  description   text not null,
  responsible   text,
  due_date      date,
  status        text not null default 'Not Done'
                  check (status in ('Done','Not Done')),
  completion_date date,
  created_at    timestamptz not null default now(),
  unique (incident_id, action_number)
);

-- ------------------------------------------------------------------ 2
-- atomic submit  (the only write path open to the incident form)
-- ------------------------------------------------------------------
create or replace function submit_incident_report(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year   int  := extract(year from (payload->>'incident_date')::date);
  v_seq    int;
  v_number text;
  v_id     uuid;
  v_act    jsonb;
  v_n      int := 0;
begin
  if coalesce(trim(payload->>'description'),'') = '' then
    raise exception 'description is required';
  end if;
  if coalesce(trim(payload->>'department'),'') = '' then
    raise exception 'department is required';
  end if;

  -- two officers submitting in the same second can never collide
  perform pg_advisory_xact_lock(hashtext('INC' || v_year::text));
  select coalesce(max(seq_no),0) + 1 into v_seq
    from hse_incidents where seq_year = v_year;
  v_number := 'INC-' || v_year || '-' || lpad(v_seq::text, 4, '0');

  insert into hse_incidents (
    report_number, seq_year, seq_no,
    incident_date, incident_time, person_name, affiliation, hiring_date,
    has_injury, injury_no, injury_type, has_damage, damage_no, damage_types,
    description, attachment, witnesses, dept_manager,
    incident_location, incident_cause, injured_part_detail,
    unsafe_act, unsafe_condition,
    direct_causes, indirect_causes, root_causes, corrective_action,
    analyst, analysis_date, hse_manager,
    source, department, nationality, shift, category, injured_part,
    return_date, responsible, execution_date, status, reported_by, client_info
  ) values (
    v_number, v_year, v_seq,
    (payload->>'incident_date')::date,
    nullif(payload->>'incident_time','')::time,
    nullif(payload->>'person_name',''),
    nullif(payload->>'affiliation',''),
    nullif(payload->>'hiring_date','')::date,
    coalesce((payload->>'has_injury')::boolean,false),
    nullif(payload->>'injury_no','')::int,
    nullif(payload->>'injury_type',''),
    coalesce((payload->>'has_damage')::boolean,false),
    nullif(payload->>'damage_no','')::int,
    coalesce(array(select jsonb_array_elements_text(payload->'damage_types')),'{}'),
    payload->>'description',
    nullif(payload->>'attachment',''),
    coalesce(array(select jsonb_array_elements_text(payload->'witnesses')),'{}'),
    nullif(payload->>'dept_manager',''),
    nullif(payload->>'incident_location',''),
    nullif(payload->>'incident_cause',''),
    nullif(payload->>'injured_part_detail',''),
    coalesce(array(select jsonb_array_elements_text(payload->'unsafe_act')),'{}'),
    coalesce(array(select jsonb_array_elements_text(payload->'unsafe_condition')),'{}'),
    nullif(payload->>'direct_causes',''),
    nullif(payload->>'indirect_causes',''),
    nullif(payload->>'root_causes',''),
    nullif(payload->>'corrective_action',''),
    nullif(payload->>'analyst',''),
    nullif(payload->>'analysis_date','')::date,
    nullif(payload->>'hse_manager',''),
    coalesce(nullif(payload->>'source',''),'Injury'),
    payload->>'department',
    nullif(payload->>'nationality',''),
    nullif(payload->>'shift',''),
    nullif(payload->>'category',''),
    nullif(payload->>'injured_part',''),
    nullif(payload->>'return_date','')::date,
    nullif(payload->>'responsible',''),
    nullif(payload->>'execution_date','')::date,
    coalesce(nullif(payload->>'status',''),'Not Done'),
    payload->>'reported_by',
    nullif(payload->>'client_info','')
  ) returning id into v_id;

  for v_act in select * from jsonb_array_elements(coalesce(payload->'actions','[]'::jsonb))
  loop
    if coalesce(trim(v_act->>'description'),'') <> '' then
      v_n := v_n + 1;
      insert into hse_incident_actions
        (incident_id, action_number, description, responsible, due_date, status)
      values (v_id, v_n, v_act->>'description', nullif(v_act->>'responsible',''),
              nullif(v_act->>'due_date','')::date,
              coalesce(nullif(v_act->>'status',''),'Not Done'));
    end if;
  end loop;

  insert into hse_audit (report_id, action, detail)
  values (v_id, 'incident_submit', jsonb_build_object('report_number', v_number));

  return jsonb_build_object('report_number', v_number, 'id', v_id);
end;
$$;

-- ------------------------------------------------------------------ 3
-- ONE register for the dashboard: violations + near misses + incidents
-- ------------------------------------------------------------------
create or replace view action_plan_view as
select
  r.report_number,
  r.description,
  r.cause,
  r.source,
  r.department,
  to_char(r.report_date,'YYYY-MM-DD')            as date,
  null::text                                      as nationality,
  coalesce((select string_agg(a.action_number || ') ' || a.description, E'\n'
                              order by a.action_number)
              from hse_corrective_actions a where a.report_id = r.id), '')
                                                  as "correctiveAction",
  r.responsible,
  to_char(r.execution_date,'YYYY-MM-DD')          as "executionDate",
  r.status,
  r.reported_by                                   as "reportedBy",
  null::text                                      as "returnDate",
  null::text                                      as "injuredPart",
  null::text                                      as shift,
  null::text                                      as category,
  r.risk_classification,
  r.created_at
from hse_reports r
where r.cancelled = false

union all

select
  i.report_number,
  i.description,
  -- an incident is classified by what the analysis found
  case when array_length(i.unsafe_act,1) > 0
       then 'Un safe action' else 'Un safe condition' end,
  i.source,
  i.department,
  to_char(i.incident_date,'YYYY-MM-DD'),
  i.nationality,
  trim(both E'\n' from
    coalesce(i.corrective_action,'') || E'\n' ||
    coalesce((select string_agg(a.action_number || ') ' || a.description, E'\n'
                                order by a.action_number)
                from hse_incident_actions a where a.incident_id = i.id), '')),
  i.responsible,
  to_char(i.execution_date,'YYYY-MM-DD'),
  i.status,
  i.reported_by,
  to_char(i.return_date,'YYYY-MM-DD'),
  i.injured_part,
  i.shift,
  i.category,
  null::text,
  i.created_at
from hse_incidents i
where i.cancelled = false;

-- ------------------------------------------------------------------ 4
-- RLS + grants
-- ------------------------------------------------------------------
alter table hse_incidents        enable row level security;
alter table hse_incident_actions enable row level security;

drop policy if exists read_incidents on hse_incidents;
create policy read_incidents on hse_incidents
  for select to anon, authenticated using (true);

drop policy if exists read_incident_actions on hse_incident_actions;
create policy read_incident_actions on hse_incident_actions
  for select to anon, authenticated using (true);

-- no insert/update/delete policy on purpose: writing goes through the
-- security-definer function only
grant execute on function submit_incident_report(jsonb) to anon, authenticated;
grant select on action_plan_view to anon, authenticated;

-- =====================================================================
--  done.
-- =====================================================================
