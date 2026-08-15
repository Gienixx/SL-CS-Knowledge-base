-- Preserve the existing NULL-schedule unscheduled clock-in capability while
-- allowing a later unscheduled session after an earlier one is completed.
drop index if exists public.attendance_user_unscheduled_date_unique;
