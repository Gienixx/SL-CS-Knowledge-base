drop policy if exists "Workforce admins can create announcements"
on public.team_announcements;

create policy "Workforce admins can create announcements"
on public.team_announcements
for insert
to authenticated
with check (
  public.workforce_current_user_is_active()
  and public.workforce_is_admin()
  and public.workforce_is_current_identity(created_by)
);
