import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Home labels the administrator entry as Website management', async () => {
  const page = await read('home.html')

  assert.match(page, /id="homeAnnouncementManagementBtn"[^>]+announcement-management\.html/)
  assert.match(page, />Website management<\/span>/)
})

test('Website Management provides announcement and To-Do tabs', async () => {
  const page = await read('announcement-management.html')
  const script = await read('scripts/announcement-management.js')

  assert.match(page, /<h1>Website Management<\/h1>/)
  assert.match(page, /id="announcementManagementTab"[^>]+role="tab"/)
  assert.match(page, /id="todoManagementTab"[^>]+role="tab"[^>]+hidden/)
  assert.match(page, /id="announcementManagementPanel"[^>]+role="tabpanel"/)
  assert.match(page, /id="todoManagementPanel"[^>]+role="tabpanel"/)
  assert.match(script, /setActiveTab\('todos'\)/)
  assert.match(script, /elements\.todoTab\.hidden = !isAdmin/)
  assert.match(script, /if \(access\.is_admin === true\) \{[\s\S]*managementLoaders\.push/)
})

test('Administrators can assign and maintain tasks for active users', async () => {
  const page = await read('announcement-management.html')
  const script = await read('scripts/announcement-management.js')

  assert.match(page, /id="todoAssignee"/)
  assert.match(page, /id="todoAssigneeCount"/)
  assert.match(page, /id="todoSelectAll"/)
  assert.match(page, /id="todoClearSelection"/)
  assert.match(page, /id="todoTitle"/)
  assert.match(page, /id="todoSortOrder"/)
  assert.match(page, /id="todoIsActive"/)
  assert.match(script, /\.from\('profiles'\)/)
  assert.match(script, /\.in\('employment_status', \['active', 'on_leave'\]\)/)
  assert.match(script, /\.from\('home_todo_items'\)/)
  assert.match(script, /selectedTodoAssigneeIds/)
  assert.match(script, /\.insert\(assignedTo\.map\(assignedToId/)
  assert.match(script, /assigned_to: assignedToId/)
  assert.match(script, /additionalAssignees\.map/)
  assert.match(script, /created_by: state\.access\.user_id/)
  assert.match(script, /updateTodoActiveState/)
})

test('Assigned task migration restricts regular users and admin writes', async () => {
  const migration = await read('supabase/migrations/20260718084625_assign_home_todos_to_users.sql')

  assert.match(migration, /add column assigned_to uuid references public\.profiles\(user_id\)/)
  assert.match(migration, /Users can view assigned home tasks/)
  assert.match(migration, /public\.workforce_is_current_identity\(assigned_to\)/)
  assert.match(migration, /public\.workforce_is_admin\(\)/)
  assert.match(migration, /assigned_to is not null/)
  assert.match(migration, /Agents can complete assigned tasks today/)
  assert.match(migration, /item\.assigned_to is null/)
})

test('To-Do management exposes the administrator activity log table', async () => {
  const page = await read('announcement-management.html')
  const script = await read('scripts/announcement-management.js')

  assert.match(page, /id="todoActivityLogTitle">Activity log/)
  assert.match(page, /<th scope="col">Timestamp<\/th>/)
  assert.match(page, /<th scope="col">Task<\/th>/)
  assert.match(page, /<th scope="col">Agent<\/th>/)
  assert.match(page, /<th scope="col">Action<\/th>/)
  assert.match(page, /id="todoActivityLogRefresh"/)
  assert.match(script, /\.from\('home_todo_activity_logs'\)/)
  assert.match(script, /\.order\('occurred_at', \{ ascending: false \}\)/)
  assert.match(script, /\.limit\(100\)/)
  assert.match(script, /timeZone: 'America\/New_York'/)
  assert.match(script, /checked \? 'Checked' : 'Unchecked'/)
})

test('Database trigger appends checkbox activity and limits reads to admins', async () => {
  const migration = await read('supabase/migrations/20260718090225_log_home_todo_activity.sql')

  assert.match(migration, /create table public\.home_todo_activity_logs/)
  assert.match(migration, /action in \('checked', 'unchecked'\)/)
  assert.match(migration, /enable row level security/)
  assert.match(migration, /using \(public\.workforce_is_admin\(\)\)/)
  assert.match(migration, /revoke insert, update, delete[^;]+from anon, authenticated/)
  assert.match(migration, /security definer/)
  assert.match(migration, /set search_path = ''/)
  assert.match(migration, /after insert or delete on public\.home_todo_completions/)
  assert.match(migration, /case when tg_op = 'INSERT' then 'checked' else 'unchecked' end/)
})

test('Website Management and Home checklist modules have valid syntax', () => {
  for (const script of [
    'scripts/announcement-management.js',
    'scripts/home-daily-overview.js'
  ]) {
    const result = spawnSync(process.execPath, ['--check', script], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8'
    })

    assert.equal(result.status, 0, result.stderr)
  }
})
