import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL(
  '../supabase/migrations/20260723073843_manage_agent_rates.sql',
  import.meta.url
)
const pageUrl = new URL('../agent-rates.html', import.meta.url)
const scriptUrl = new URL('../scripts/agent-rates.js', import.meta.url)
const homeUrl = new URL('../home.html', import.meta.url)
const homeNavigationUrl = new URL(
  '../scripts/home-workforce-nav.js',
  import.meta.url
)

test('agent rate history is immutable at the database boundary', async () => {
  const migration = await readFile(migrationUrl, 'utf8')

  assert.match(
    migration,
    /create trigger agent_rates_prevent_mutation[\s\S]*before update or delete on public\.agent_rates/
  )
  assert.match(
    migration,
    /Agent rate history is immutable\. Add a new effective-dated rate instead\./
  )
  assert.match(
    migration,
    /revoke execute on function public\.payroll_prevent_agent_rate_mutation\(\) from anon, authenticated/
  )
})

test('rate creation requires explicit payroll permission and writes an audit log', async () => {
  const migration = await readFile(migrationUrl, 'utf8')

  assert.match(
    migration,
    /create or replace function public\.payroll_create_agent_rate\(/
  )
  assert.match(
    migration,
    /not public\.workforce_has_permission\('manage_agent_rates'\)/
  )
  assert.match(migration, /insert into public\.agent_rates/)
  assert.match(migration, /insert into public\.payroll_audit_logs/)
  assert.match(migration, /'agent_rate_created'/)
  assert.match(
    migration,
    /revoke execute on function public\.payroll_create_agent_rate\([\s\S]*?\) from anon/
  )
})

test('authorized directory RPC exposes eligible employees and historical rates', async () => {
  const migration = await readFile(migrationUrl, 'utf8')

  assert.match(
    migration,
    /create or replace function public\.payroll_get_agent_rate_directory\(\)/
  )
  assert.match(
    migration,
    /profile\.is_agent is true[\s\S]*profile\.employment_status::text in \('active', 'on_leave'\)/
  )
  assert.match(
    migration,
    /left join public\.agent_rates as rate[\s\S]*rate\.employee_id = profile\.user_id/
  )
  assert.match(
    migration,
    /revoke execute on function public\.payroll_get_agent_rate_directory\(\) from anon/
  )
})

test('agent rates page supports all effective-dated rate fields and history', async () => {
  const [page, script] = await Promise.all([
    readFile(pageUrl, 'utf8'),
    readFile(scriptUrl, 'utf8')
  ])

  for (const id of [
    'hourlyRate',
    'dailyRate',
    'monthlyRate',
    'overtimeRate',
    'holidayRate',
    'rateEffectiveDate',
    'rateChangeReason',
    'rateHistoryBody'
  ]) {
    assert.match(page, new RegExp(`id="${id}"`))
  }

  assert.match(
    script,
    /requireWorkforcePermission\([\s\S]*?'manage_agent_rates'/
  )
  assert.match(script, /supabase\.rpc\('payroll_get_agent_rate_directory'\)/)
  assert.match(script, /supabase\.rpc\('payroll_create_agent_rate', payload\)/)
  assert.doesNotMatch(script, /\.from\('agent_rates'\)\.(?:update|delete)/)
  assert.doesNotMatch(page, />\s*(?:Edit|Delete)\s*</i)
})

test('home navigation reveals Agent Rates only through manage_agent_rates', async () => {
  const [home, navigation] = await Promise.all([
    readFile(homeUrl, 'utf8'),
    readFile(homeNavigationUrl, 'utf8')
  ])

  assert.match(
    home,
    /id="homeAgentRatesBtn"[\s\S]*href="\.\/agent-rates\.html"[\s\S]*hidden/
  )
  assert.match(
    navigation,
    /canManageAgentRates = hasWorkforcePermission\([\s\S]*?'manage_agent_rates'/
  )
  assert.match(
    navigation,
    /agentRatesButton\.hidden = !canManageAgentRates/
  )
})
