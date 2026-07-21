create table public.home_todo_activity_logs (
  id bigint generated always as identity primary key,
  todo_item_id uuid references public.home_todo_items(id) on delete set null,
  task_title text not null,
  auth_user_id uuid references auth.users(id) on delete set null,
  profile_user_id uuid references public.profiles(user_id) on delete set null,
  agent_name text not null,
  action text not null,
  completion_date date not null,
  occurred_at timestamptz not null default now(),
  constraint home_todo_activity_task_not_blank check (btrim(task_title) <> ''),
  constraint home_todo_activity_agent_not_blank check (btrim(agent_name) <> ''),
  constraint home_todo_activity_action_valid check (action in ('checked', 'unchecked'))
);

create index home_todo_activity_logs_occurred_at_idx
  on public.home_todo_activity_logs (occurred_at desc);

create index home_todo_activity_logs_profile_date_idx
  on public.home_todo_activity_logs (profile_user_id, completion_date desc);

create index home_todo_activity_logs_todo_item_idx
  on public.home_todo_activity_logs (todo_item_id);

create index home_todo_activity_logs_auth_user_idx
  on public.home_todo_activity_logs (auth_user_id);

alter table public.home_todo_activity_logs enable row level security;

create policy "Workforce admins can view home task activity"
  on public.home_todo_activity_logs
  for select
  to authenticated
  using (public.workforce_is_admin());

grant select on public.home_todo_activity_logs to authenticated;
revoke insert, update, delete on public.home_todo_activity_logs from anon, authenticated;

insert into public.home_todo_activity_logs (
  todo_item_id,
  task_title,
  auth_user_id,
  profile_user_id,
  agent_name,
  action,
  completion_date,
  occurred_at
)
select
  completion.todo_item_id,
  item.title,
  completion.auth_user_id,
  completion.profile_user_id,
  coalesce(nullif(btrim(profile.full_name), ''), nullif(btrim(profile.email), ''), 'Unknown agent'),
  'checked',
  completion.completion_date,
  completion.completed_at
from public.home_todo_completions completion
join public.home_todo_items item on item.id = completion.todo_item_id
left join public.profiles profile on profile.user_id = completion.profile_user_id;

create or replace function public.log_home_todo_completion_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_todo_item_id uuid;
  v_auth_user_id uuid;
  v_profile_user_id uuid;
  v_completion_date date;
  v_task_title text;
  v_agent_name text;
begin
  if tg_op = 'INSERT' then
    v_todo_item_id := new.todo_item_id;
    v_auth_user_id := new.auth_user_id;
    v_profile_user_id := new.profile_user_id;
    v_completion_date := new.completion_date;
  else
    v_todo_item_id := old.todo_item_id;
    v_auth_user_id := old.auth_user_id;
    v_profile_user_id := old.profile_user_id;
    v_completion_date := old.completion_date;
  end if;

  select item.title
  into v_task_title
  from public.home_todo_items item
  where item.id = v_todo_item_id;

  select coalesce(
    nullif(btrim(profile.full_name), ''),
    nullif(btrim(profile.email), ''),
    'Unknown agent'
  )
  into v_agent_name
  from public.profiles profile
  where profile.user_id = v_profile_user_id;

  insert into public.home_todo_activity_logs (
    todo_item_id,
    task_title,
    auth_user_id,
    profile_user_id,
    agent_name,
    action,
    completion_date,
    occurred_at
  ) values (
    v_todo_item_id,
    coalesce(nullif(btrim(v_task_title), ''), 'Unknown task'),
    v_auth_user_id,
    v_profile_user_id,
    coalesce(nullif(btrim(v_agent_name), ''), 'Unknown agent'),
    case when tg_op = 'INSERT' then 'checked' else 'unchecked' end,
    v_completion_date,
    now()
  );

  return case when tg_op = 'INSERT' then new else old end;
end;
$$;

revoke all on function public.log_home_todo_completion_activity() from public, anon, authenticated;

create trigger home_todo_completion_activity_trigger
after insert or delete on public.home_todo_completions
for each row
execute function public.log_home_todo_completion_activity();
