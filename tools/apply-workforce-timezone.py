from pathlib import Path

OLD_ZONE = 'Asia/Manila'
NEW_ZONE = 'America/New_York'

live_files = [
    Path('attendance.html'),
    Path('scripts/attendance.js'),
    Path('scripts/my-schedule-v2.js'),
    Path('scripts/team-management.js'),
    Path('scripts/workforce-schedules.js'),
    Path('scripts/workforce.js'),
    Path('shared/workforce-access.js'),
    Path('workforce.html'),
]

for path in live_files:
    text = path.read_text()
    text = text.replace(OLD_ZONE, NEW_ZONE)
    if path == Path('scripts/team-management.js'):
        text = text.replace("new Intl.DateTimeFormat('en-PH'", "new Intl.DateTimeFormat('en-US'")
    path.write_text(text)

Path('supabase/migrations/2026070802_workforce_timezone_new_york.sql').write_text("""-- Workforce timezone default: America/New_York
--
-- Changes the workforce default from Asia/Manila to America/New_York while
-- preserving the wall-clock start and end times of existing Manila schedules.
-- Existing attendance timestamps remain unchanged because they represent actual
-- recorded instants. New attendance work dates use each profile's updated zone.

begin;

alter table public.profiles
  alter column timezone set default 'America/New_York';

alter table public.work_schedules
  alter column timezone set default 'America/New_York';

-- Preserve the displayed local shift time when moving an existing schedule from
-- Manila to New York. For example, a stored 9:00 AM Manila shift remains a
-- 9:00 AM shift after its timezone is changed to America/New_York.
update public.work_schedules
set shift_start = case
      when shift_start is null then null
      else (shift_start at time zone 'Asia/Manila') at time zone 'America/New_York'
    end,
    shift_end = case
      when shift_end is null then null
      else (shift_end at time zone 'Asia/Manila') at time zone 'America/New_York'
    end,
    timezone = 'America/New_York',
    updated_by = coalesce(updated_by, auth.uid())
where timezone = 'Asia/Manila';

update public.profiles
set timezone = 'America/New_York'
where timezone = 'Asia/Manila';

-- Older RPC definitions still use Asia/Manila as an omitted-argument fallback.
-- Normalize only that legacy fallback (plus null/blank values), while continuing
-- to permit an explicitly configured IANA timezone other than Manila.
create or replace function public.workforce_normalize_timezone_default()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.timezone is null
     or nullif(trim(new.timezone), '') is null
     or new.timezone = 'Asia/Manila' then
    new.timezone := 'America/New_York';
  end if;

  -- Reject invalid IANA timezone names before the row is stored.
  perform now() at time zone new.timezone;
  return new;
end;
$$;

drop trigger if exists profiles_normalize_timezone_default on public.profiles;
create trigger profiles_normalize_timezone_default
before insert or update of timezone on public.profiles
for each row execute function public.workforce_normalize_timezone_default();

drop trigger if exists work_schedules_normalize_timezone_default on public.work_schedules;
create trigger work_schedules_normalize_timezone_default
before insert or update of timezone on public.work_schedules
for each row execute function public.workforce_normalize_timezone_default();

revoke all on function public.workforce_normalize_timezone_default() from public;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  auth.uid(),
  'workforce_timezone_changed',
  'workforce_configuration',
  jsonb_build_object(
    'previous_timezone', 'Asia/Manila',
    'default_timezone', 'America/New_York',
    'profile_count', (
      select count(*) from public.profiles where timezone = 'America/New_York'
    ),
    'schedule_count', (
      select count(*) from public.work_schedules where timezone = 'America/New_York'
    ),
    'schedule_wall_times_preserved', true
  ),
  'Changed the workforce default timezone to America/New_York'
);

comment on function public.workforce_normalize_timezone_default() is
  'Maps legacy Manila or blank workforce timezone values to America/New_York and validates other IANA zones.';

commit;
""")

Path('supabase/verification/workforce_timezone_check.sql').write_text("""-- Workforce timezone verification
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
""")

Path('tests/workforce-timezone.test.mjs').write_text("""import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const LIVE_TIMEZONE_FILES = [
  'attendance.html',
  'workforce.html',
  'scripts/attendance.js',
  'scripts/my-schedule-v2.js',
  'scripts/team-management.js',
  'scripts/workforce-schedules.js',
  'scripts/workforce.js',
  'shared/workforce-access.js'
]

test('live workforce interfaces default to America/New_York', async () => {
  for (const path of LIVE_TIMEZONE_FILES) {
    const source = await read(path)
    assert.match(source, /America\\/New_York/, `${path} should use America/New_York`)
    assert.doesNotMatch(source, /Asia\\/Manila/, `${path} should not retain the Manila fallback`)
  }
})

test('timezone migration updates data defaults and preserves schedule wall times', async () => {
  const migration = await read('supabase/migrations/2026070802_workforce_timezone_new_york.sql')

  assert.match(migration, /alter table public\\.profiles[\\s\\S]*default 'America\\/New_York'/)
  assert.match(migration, /alter table public\\.work_schedules[\\s\\S]*default 'America\\/New_York'/)
  assert.match(migration, /shift_start at time zone 'Asia\\/Manila'/)
  assert.match(migration, /at time zone 'America\\/New_York'/)
  assert.match(migration, /function public\\.workforce_normalize_timezone_default\\(\\)/)
  assert.match(migration, /profiles_normalize_timezone_default/)
  assert.match(migration, /work_schedules_normalize_timezone_default/)
})

test('timezone verification checks defaults, records, triggers, and audit entry', async () => {
  const verification = await read('supabase/verification/workforce_timezone_check.sql')

  assert.match(verification, /information_schema\\.columns/)
  assert.match(verification, /where timezone = 'Asia\\/Manila'/)
  assert.match(verification, /information_schema\\.triggers/)
  assert.match(verification, /workforce_timezone_changed/)
})
""")

Path('docs/workforce-timezone-new-york.md').write_text("""# Workforce Timezone — America/New_York

The workforce, schedule, and attendance interfaces now use `America/New_York` as their default IANA timezone.

## Database deployment

Apply:

```text
supabase/migrations/2026070802_workforce_timezone_new_york.sql
```

Then run:

```text
supabase/verification/workforce_timezone_check.sql
```

The migration:

- changes the `profiles.timezone` and `work_schedules.timezone` defaults;
- updates existing records still set to `Asia/Manila`;
- preserves existing schedule wall-clock start and end times while changing their timezone;
- leaves historical attendance timestamps unchanged because they are actual recorded instants;
- normalizes legacy RPC fallback values to `America/New_York` through database triggers;
- continues accepting other explicitly configured valid IANA timezones.

After deployment, create or edit a test shift and confirm the schedule, attendance page, clock-in date, and clock-out date all follow Eastern Time, including daylight-saving changes.
""")

step5 = Path('docs/workforce-step-5-agent-schedule-attendance.md')
text = step5.read_text()
text = text.replace(
    "1. Apply `supabase/migrations/2026070801_agent_attendance_interface.sql` in the internal Supabase environment.\n2. Run `supabase/verification/agent_attendance_check.sql`.\n3. Deploy the site files to the internal Cloudflare Pages environment.\n4. Test with a Regular Agent account.\n5. Test with an Agent with Article Editor access account.\n6. Test with an Admin and Agent account.\n7. Confirm an Admin-only account is denied attendance clock access.\n8. Test a released shift, changed shift, rest day, unscheduled day, duplicate clock-in, and clock-out.\n9. Review the resulting rows in `attendance` and `workforce_audit_logs`.",
    "1. Apply `supabase/migrations/2026070801_agent_attendance_interface.sql` in the internal Supabase environment.\n2. Apply `supabase/migrations/2026070802_workforce_timezone_new_york.sql`.\n3. Run `supabase/verification/agent_attendance_check.sql` and `supabase/verification/workforce_timezone_check.sql`.\n4. Deploy the site files to the internal Cloudflare Pages environment.\n5. Test with a Regular Agent account.\n6. Test with an Agent with Article Editor access account.\n7. Test with an Admin and Agent account.\n8. Confirm an Admin-only account is denied attendance clock access.\n9. Test a released shift, changed shift, rest day, unscheduled day, duplicate clock-in, and clock-out.\n10. Review the resulting rows in `attendance` and `workforce_audit_logs`."
)
step5.write_text(text)

Path('tools/apply-workforce-timezone.py').unlink(missing_ok=True)
Path('.github/workflows/export-timezone-branch.yml').unlink(missing_ok=True)
