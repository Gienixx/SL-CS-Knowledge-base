-- Phase 1 profile RLS hardening
--
-- Profile rows contain role and access-type fields. Direct profile mutations
-- therefore remain global-administrator operations. Team-scoped supervisors
-- may view assigned profiles but cannot promote roles or alter access flags.

drop policy if exists "Authorized users can update workforce profiles" on public.profiles;
create policy "Workforce admins can update profiles"
on public.profiles
for update
to authenticated
using (
  public.workforce_is_admin()
  and public.workforce_has_permission('manage_employees')
)
with check (
  public.workforce_is_admin()
  and public.workforce_has_permission('manage_employees')
);
