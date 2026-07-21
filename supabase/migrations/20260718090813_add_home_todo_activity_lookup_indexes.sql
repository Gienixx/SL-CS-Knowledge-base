create index home_todo_activity_logs_todo_item_idx
  on public.home_todo_activity_logs (todo_item_id);

create index home_todo_activity_logs_auth_user_idx
  on public.home_todo_activity_logs (auth_user_id);
