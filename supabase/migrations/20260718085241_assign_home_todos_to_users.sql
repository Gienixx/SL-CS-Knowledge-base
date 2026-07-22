alter table public.home_todo_items
  add column assigned_to uuid references public.profiles(user_id) on delete cascade;

create index home_todo_items_assigned_active_idx
  on public.home_todo_items (assigned_to, is_active, sort_order, created_at);

drop policy if exists "Active workforce users can view home tasks"
  on public.home_todo_items;
drop policy if exists "Workforce admins can create home tasks"
  on public.home_todo_items;
drop policy if exists "Workforce admins can update home tasks"
  on public.home_todo_items;
drop policy if exists "Workforce admins can delete home tasks"
  on public.home_todo_items;
drop policy if exists "Agents can complete their own tasks today"
  on public.home_todo_completions;

create policy "Users can view assigned home tasks"
  on public.home_todo_items
  for select
  to authenticated
  using (
    public.workforce_current_user_is_active()
    and (
      public.workforce_is_admin()
      or (
        is_active
        and (
          assigned_to is null
          or public.workforce_is_current_identity(assigned_to)
        )
      )
    )
  );

create policy "Workforce admins can create home tasks"
  on public.home_todo_items
  for insert
  to authenticated
  with check (
    public.workforce_is_admin()
    and assigned_to is not null
    and (
      created_by is null
      or public.workforce_is_current_identity(created_by)
    )
  );

create policy "Workforce admins can update home tasks"
  on public.home_todo_items
  for update
  to authenticated
  using (public.workforce_is_admin())
  with check (public.workforce_is_admin());

create policy "Workforce admins can delete home tasks"
  on public.home_todo_items
  for delete
  to authenticated
  using (public.workforce_is_admin());

create policy "Agents can complete assigned tasks today"
  on public.home_todo_completions
  for insert
  to authenticated
  with check (
    (select auth.uid()) = auth_user_id
    and public.workforce_is_current_identity(profile_user_id)
    and completion_date = ((now() at time zone 'America/New_York')::date)
    and exists (
      select 1
      from public.home_todo_items item
      where item.id = todo_item_id
        and item.is_active
        and (
          item.assigned_to is null
          or public.workforce_is_current_identity(item.assigned_to)
        )
    )
  );

grant select, insert, update, delete on public.home_todo_items to authenticated;
