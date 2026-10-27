-- The current Individual Payslip read model intentionally omits billed clock
-- timestamps. Capture them from the source Attendance rows when the V2 payroll
-- snapshot is inserted, without changing those operational rows.
create or replace function public.payroll_v2_capture_billed_timestamps()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if jsonb_array_length(coalesce(new.billed_timestamps, '[]'::jsonb)) = 0
     and cardinality(coalesce(new.source_attendance_ids, '{}'::uuid[])) > 0 then
    select coalesce(jsonb_agg(jsonb_build_object(
      'attendance_id', attendance.id,
      'billed_clock_in', attendance.billed_clock_in,
      'billed_clock_out', attendance.billed_clock_out
    ) order by attendance.id), '[]'::jsonb)
    into new.billed_timestamps
    from public.attendance attendance
    where attendance.id = any(new.source_attendance_ids);
  end if;
  return new;
end;
$function$;

revoke all on function public.payroll_v2_capture_billed_timestamps()
  from public, anon, authenticated;

create trigger payroll_v2_capture_billed_timestamps_before_insert
before insert on public.payroll_v2_attendance_snapshots
for each row execute function public.payroll_v2_capture_billed_timestamps();

;
