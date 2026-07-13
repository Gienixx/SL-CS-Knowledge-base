import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260713165822_add_user_schedule_templates.sql'

test('additional templates use verified production emails', async () => {
  const migration = await read(migrationPath)

  for (const email of [
    'jean@eurekasurveys.com',
    'ford@eurekasurveys.com',
    'gen@eurekasurveys.com',
    'arez@eurekasurveys.com',
    'almar@eurekasurveys.com'
  ]) assert.match(migration, new RegExp(email.replace('.', '\\.')))

  assert.doesNotMatch(migration, /arez@eurekasurveyse\.com/)
})

test('Almar is the only explicit admin exception', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /add column if not exists allow_admin_agent boolean not null default false/)
  assert.match(migration, /profile\.base_role = 'agent' or assignment\.allow_admin_agent/)
  assert.match(migration, /"email": "almar@eurekasurveys\.com",[\s\S]*?"allow_admin": true/)
  assert.equal((migration.match(/"allow_admin": true/g) || []).length, 1)
})

test('all five templates contain seven weekday entries', async () => {
  const migration = await read(migrationPath)

  for (const name of ['Jean', 'Ford', 'Gen', 'Arez', 'Almar']) {
    assert.match(migration, new RegExp(`"name": "${name} weekly schedule"`))
  }
  assert.equal((migration.match(/"weekday":/g) || []).length, 35)
})

test('generator remains idempotent and published by default', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /on conflict \(user_id, shift_date, shift_sequence\) do nothing/)
  assert.match(migration, /else 'published' end/)
  assert.match(migration, /select public\.workforce_generate_weekly_schedules\(\)/)
})
