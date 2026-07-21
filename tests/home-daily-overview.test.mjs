import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Home exposes the daily checklist and celebrations panels', async () => {
  const page = await read('home.html')

  assert.match(page, /id="homeTodoList"/)
  assert.match(page, />To-Do List</)
  assert.match(page, /id="homeCelebrationsList"/)
  assert.match(page, />Anniversaries and Birthdays</)
  assert.match(page, /home-daily-overview\.js\?v=3/)
})

test('Daily checklist saves only the current agent daily completion', async () => {
  const script = await read('scripts/home-daily-overview.js')

  assert.match(script, /WORK_TIME_ZONE = 'America\/New_York'/)
  assert.match(script, /\.from\('home_todo_items'\)/)
  assert.match(script, /\.from\('home_todo_completions'\)/)
  assert.match(script, /auth_user_id: user\.id/)
  assert.match(script, /profile_user_id: profileUserId/)
  assert.match(script, /completion_date: today/)
  assert.match(script, /assigned_to\.is\.null,assigned_to\.in/)
  assert.match(script, /linked_profile_ids/)
})

test('Daily overview migration protects agent completions with RLS', async () => {
  const migration = await read('supabase/migrations/20260718075314_home_daily_todos_and_celebrations.sql')

  assert.match(migration, /alter table public\.home_todo_completions enable row level security/)
  assert.match(migration, /\(select auth\.uid\(\)\) = auth_user_id/)
  assert.match(migration, /workforce_is_current_identity\(profile_user_id\)/)
  assert.match(migration, /Users can view permitted task completions/)
  assert.match(migration, /view_workforce_reports/)
})

test('Home daily overview script has valid JavaScript syntax', () => {
  const result = spawnSync(process.execPath, ['--check', 'scripts/home-daily-overview.js'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
})

test('Organizational chart celebrations seed only verified modal details', async () => {
  const migration = await read('supabase/migrations/20260718080944_seed_home_celebrations_from_org_chart.sql')

  const chartModals = [
    'Arezval Loiej Angelo A. Santos',
    'Jerson V. Gavileño',
    'Alen Tristan Adeva',
    'Amora Angeles',
    'Leufard P. Vallega',
    'Genevive Serrano',
    'Jean-Michel Jarre Vestil'
  ]

  chartModals.forEach(name => assert.match(migration, new RegExp(name)))
  assert.doesNotMatch(migration, /Arby|Almar|Kirby|Tommy/)
  assert.match(migration, /where not exists/)
})
