create extension if not exists pgcrypto;

create table public.home_todo_items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_by uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint home_todo_items_title_not_blank check (length(trim(title)) > 0)
);

create table public.home_todo_completions (
  todo_item_id uuid not null references public.home_todo_items(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  profile_user_id uuid not null references public.profiles(user_id) on delete restrict,
  completion_date date not null default ((now() at time zone 'America/New_York')::date),
  completed_at timestamptz not null default now(),
  primary key (todo_item_id, auth_user_id, completion_date),
  constraint home_todo_completion_current_date check (
    completion_date = ((completed_at at time zone 'America/New_York')::date)
  )
);

create index home_todo_completions_profile_date_idx
  on public.home_todo_completions (profile_user_id, completion_date desc);

create table public.home_celebrations (
  id uuid primary key default gen_random_uuid(),
  profile_user_id uuid references public.profiles(user_id) on delete set null,
  display_name text not null,
  event_type text not null,
  event_month smallint not null,
  event_day smallint not null,
  start_year smallint,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint home_celebrations_name_not_blank check (length(trim(display_name)) > 0),
  constraint home_celebrations_type_check check (event_type in ('birthday', 'anniversary')),
  constraint home_celebrations_month_check check (event_month between 1 and 12),
  constraint home_celebrations_day_check check (event_day between 1 and 31),
  constraint home_celebrations_start_year_check check (
    (event_type = 'birthday' and start_year is null)
    or (event_type = 'anniversary' and start_year between 1900 and 9999)
  )
);

alter table public.home_todo_items enable row level security;
alter table public.home_todo_completions enable row level security;
alter table public.home_celebrations enable row level security;

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

create policy "Agents can complete their own tasks today"
  on public.home_todo_completions for insert to authenticated
  with check (
    (select auth.uid()) = auth_user_id
    and public.workforce_is_current_identity(profile_user_id)
    and completion_date = ((now() at time zone 'America/New_York')::date)
  );

create policy "Agents can reopen their own tasks today"
  on public.home_todo_completions for delete to authenticated
  using (
    (select auth.uid()) = auth_user_id
    and completion_date = ((now() at time zone 'America/New_York')::date)
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
grant select, insert, delete on public.home_todo_completions to authenticated;
grant select, insert, update, delete on public.home_celebrations to authenticated;

insert into public.home_todo_items (id, title, sort_order)
values
  ('1e7d5b59-c70b-49ed-a29e-f190c723a101', 'Review team updates', 10),
  ('1e7d5b59-c70b-49ed-a29e-f190c723a102', 'Check today''s schedule', 20),
  ('1e7d5b59-c70b-49ed-a29e-f190c723a103', 'Complete end-of-shift handoff', 30)
on conflict (id) do nothing;
