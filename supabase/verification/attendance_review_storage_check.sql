-- Phase 1, Step 8 verification: attendance review and structured storage.
-- Run after 2026070807_attendance_review_storage.sql.

-- 1. Required columns and types.
select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'attendance'
  and column_name in (
    'original_clock_in',
    'original_clock_out',
    'pre_shift_overtime_minutes',
    'regular_minutes',
    'post_shift_overtime_minutes',
    'total_overtime_minutes',
    'total_worked_minutes',
    'is_corrected',
    'review_status',
    'reviewed_by',
    'reviewed_at'
  )
order by column_name;

-- Expected: 11 rows.

-- 2. Required constraints are present and validated.
select
  constraint_name,
  constraint_type,
  is_deferrable,
  initially_deferred
from information_schema.table_constraints
where table_schema = 'public'
  and table_name = 'attendance'
  and constraint_name in (
    'attendance_structured_minutes_nonnegative',
    'attendance_review_status_check',
    'attendance_review_metadata_pair_check',
    'attendance_original_clock_order_check',
    'attendance_total_overtime_legacy_match'
  )
order by constraint_name;

select
  conname,
  convalidated
from pg_constraint
where conrelid = 'public.attendance'::regclass
  and conname in (
    'attendance_structured_minutes_nonnegative',
    'attendance_review_status_check',
    'attendance_review_metadata_pair_check',
    'attendance_original_clock_order_check',
    'attendance_total_overtime_legacy_match'
  )
order by conname;

-- Expected: five rows and every convalidated value is true.

-- 3. Storage trigger and supporting function.
select
  trigger_name,
  event_manipulation,
  action_timing,
  action_statement
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table = 'attendance'
  and trigger_name = 'attendance_prepare_storage'
order by event_manipulation;

select
  routine_name,
  routine_type
from information_schema.routines
where specific_schema = 'public'
  and routine_name = 'workforce_prepare_attendance_storage';

-- Expected: INSERT and UPDATE trigger rows plus one function row.

-- 4. Indexes used by review and correction screens.
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'attendance'
  and indexname in (
    'attendance_review_status_date_idx',
    'attendance_corrected_date_idx',
    'attendance_reviewed_by_at_idx'
  )
order by indexname;

-- Expected: three rows.

-- 5. Data integrity checks. Every query below should return zero rows.
select id, overtime_minutes, total_overtime_minutes
from public.attendance
where overtime_minutes <> total_overtime_minutes;

select id, total_worked_minutes, clock_in, clock_out
from public.attendance
where total_worked_minutes < 0
   or (
     clock_in is not null
     and clock_out is not null
     and total_worked_minutes <>
       floor(extract(epoch from (clock_out - clock_in)) / 60)::integer
   );

select id, reviewed_by, reviewed_at
from public.attendance
where (reviewed_by is null) <> (reviewed_at is null);

select id, review_status
from public.attendance
where review_status not in ('pending', 'approved', 'corrected', 'rejected', 'locked');

select id, original_clock_in, original_clock_out
from public.attendance
where original_clock_out is not null
  and (original_clock_in is null or original_clock_out < original_clock_in);

select id,
       pre_shift_overtime_minutes,
       regular_minutes,
       post_shift_overtime_minutes,
       total_overtime_minutes,
       total_worked_minutes
from public.attendance
where coalesce(pre_shift_overtime_minutes, 0) < 0
   or coalesce(regular_minutes, 0) < 0
   or coalesce(post_shift_overtime_minutes, 0) < 0
   or total_overtime_minutes < 0
   or total_worked_minutes < 0;

-- 6. Historical migration summary. Null component values are expected until
-- Step 9 performs the trusted structured recalculation.
select
  count(*) as attendance_records,
  count(*) filter (where original_clock_in is not null) as captured_original_clock_ins,
  count(*) filter (where original_clock_out is not null) as captured_original_clock_outs,
  count(*) filter (where is_corrected) as corrected_records,
  count(*) filter (
    where pre_shift_overtime_minutes is null
       or regular_minutes is null
       or post_shift_overtime_minutes is null
  ) as records_pending_structured_recalculation,
  count(*) filter (where review_status = 'pending') as pending_review_records
from public.attendance;

-- 7. Migration audit marker.
select
  action,
  entity_type,
  after_data,
  reason,
  created_at
from public.workforce_audit_logs
where action = 'attendance_review_storage_added'
order by created_at desc
limit 1;
