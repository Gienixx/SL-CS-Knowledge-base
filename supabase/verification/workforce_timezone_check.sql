-- Workforce timezone verification
-- Run after 2026070802_workforce_timezone_new_york.sql.

-- 1. Both workforce table defaults must be America/New_York.
select
  table_name,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('profiles', 'work_schedules')
  and column_name = 'timezone'
order by table_name;

-- 2. No active workforce profile should retain the previous Manila timezone.
-- Must return 0 rows.
select user_id, full_name, email, timezone
from public.profiles
where timezone = 'Asia/Manila';

-- 3. No schedule should retain the previous Manila timezone.
-- Must return 0 rows.
select id, user_id, shift_date, shift_start, shift_end, timezone
from public.work_schedules
where timezone = 'Asia/Manila';

-- 4. Timezone normalization triggers must exist and be enabled.
select
  event_object_table,
  trigger_name,
  action_timing,
  event_manipulation
from information_schema.triggers
where trigger_schema = 'public'
  and trigger_name in (
    'profiles_normalize_timezone_default',
    'work_schedules_normalize_timezone_default'
  )
order by event_object_table, event_manipulation;

-- 5. Confirm the configuration audit entry exists.
select action, entity_type, after_data, reason, created_at
from public.workforce_audit_logs
where action = 'workforce_timezone_changed'
order by created_at desc
limit 5;
