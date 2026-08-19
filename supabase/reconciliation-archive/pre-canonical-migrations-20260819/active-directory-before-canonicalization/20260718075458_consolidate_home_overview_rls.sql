drop policy if exists "Active workforce users can view home tasks"
  on public.home_todo_items;
drop policy if exists "Workforce admins can manage home tasks"
  on public.home_todo_items;
drop policy if exists "Agents can view their own task completions"
  on public.home_todo_completions;
drop policy if exists "Workforce admins can view task completion history"
  on public.home_todo_completions;
drop policy if exists "Active workforce users can view celebrations"
  on public.home_celebrations;
drop policy if exists "Workforce admins can manage celebrations"
  on public.home_celebrations;

create policy "Active workforce users can view home tasks"
  on public.home_todo_items for select to authenticated
  using (
    public.workforce_current_user_is_active()
    and (
      is_active
      or (
        public.workforce_is_admin()
        and public.workforce_has_permission('manage_employees')
      )
    )
  );

create policy "Workforce admins can create home tasks"
  on public.home_todo_items for insert to authenticated
  with check (
    public.workforce_is_admin()
    and public.workforce_has_permission('manage_employees')
  );

create policy "Workforce admins can update home tasks"
  on public.home_todo_items for update to authenticated
  using (
    public.workforce_is_admin()
    and public.workforce_has_permission('manage_employees')
  )
  with check (
    public.workforce_is_admin()
    and public.workforce_has_permission('manage_employees')
  );

create policy "Workforce admins can delete home tasks"
  on public.home_todo_items for delete to authenticated
  using (
    public.workforce_is_admin()
    and public.workforce_has_permission('manage_employees')
  );

create policy "Users can view permitted task completions"
  on public.home_todo_completions for select to authenticated
  using (
    (select auth.uid()) = auth_user_id
    or (
      public.workforce_is_admin()
      and public.workforce_has_permission('view_workforce_reports')
    )
  );

create policy "Active workforce users can view celebrations"
  on public.home_celebrations for select to authenticated
  using (
    public.workforce_current_user_is_active()
    and (
      is_active
      or (
        public.workforce_is_admin()
        and public.workforce_has_permission('manage_employees')
      )
    )
  );

create policy "Workforce admins can create celebrations"
  on public.home_celebrations for insert to authenticated
  with check (
    public.workforce_is_admin()
    and public.workforce_has_permission('manage_employees')
  );

create policy "Workforce admins can update celebrations"
  on public.home_celebrations for update to authenticated
  using (
    public.workforce_is_admin()
    and public.workforce_has_permission('manage_employees')
  )
  with check (
    public.workforce_is_admin()
    and public.workforce_has_permission('manage_employees')
  );

create policy "Workforce admins can delete celebrations"
  on public.home_celebrations for delete to authenticated
  using (
    public.workforce_is_admin()
    and public.workforce_has_permission('manage_employees')
  );

grant select, insert, update, delete on public.home_todo_items to authenticated;
grant select, insert, update, delete on public.home_celebrations to authenticated;
