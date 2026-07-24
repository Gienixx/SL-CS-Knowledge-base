import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL(
  '../supabase/migrations/20260723073843_manage_agent_rates.sql',
  import.meta.url
)
const usdMigrationUrl = new URL(
  '../supabase/migrations/20260723081057_use_usd_payroll_currency.sql',
  import.meta.url
)
const hourlyDerivationMigrationUrl = new URL(
  '../supabase/migrations/20260723091517_derive_agent_rates_from_hourly.sql',
  import.meta.url
)
const pageUrl = new URL('../agent-rates.html', import.meta.url)
const scriptUrl = new URL('../scripts/agent-rates.js', import.meta.url)
const styleUrl = new URL('../styles/agent-rates.css', import.meta.url)
const homeUrl = new URL('../home.html', import.meta.url)
const payrollDashboardUrl = new URL('../payroll-dashboard.html', import.meta.url)

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

test('USD is canonical and PHP is a live PayPal display conversion', async () => {
  const [migration, page, script] = await Promise.all([
    readFile(usdMigrationUrl, 'utf8'),
    readFile(pageUrl, 'utf8'),
    readFile(scriptUrl, 'utf8')
  ])

  assert.match(
    migration,
    /alter table public\.agent_rates[\s\S]*alter column currency_code set default 'USD'/
  )
  assert.match(
    migration,
    /add constraint agent_rates_currency_code_check[\s\S]*currency_code = 'USD'/
  )
  assert.match(migration, /'USD'[\s\S]*v_reason/)
  assert.match(page, /USD \(\$\)/)
  assert.match(page, /data-php-preview-for="hourlyRate"/)
  assert.match(script, /currency: 'USD'/)
  assert.match(script, /currency: 'PHP'/)
  assert.match(script, /fetch\('\.\/api\/paypal-exchange-rate'/)
  assert.match(script, /Authorization: `Bearer \$\{state\.accessToken\}`/)
  assert.match(script, /quote\?\.rateType === 'paypal_estimate'/)
  assert.match(
    script,
    /PayPal's published \$\{quote\.spreadPercent\}% payment\/Payouts spread/
  )
  assert.doesNotMatch(page, /effective-dated PHP pay rates/)
})

test('daily and monthly rates are derived from hourly in the browser and database', async () => {
  const [migration, page, script] = await Promise.all([
    readFile(hourlyDerivationMigrationUrl, 'utf8'),
    readFile(pageUrl, 'utf8'),
    readFile(scriptUrl, 'utf8')
  ])

  assert.match(script, /const PAID_HOURS_PER_DAY = 8/)
  assert.match(script, /const WORK_DAYS_PER_MONTH = 22/)
  assert.match(
    script,
    /dailyInput\.value = formatCalculatedRate\([\s\S]*?hourlyRate \* PAID_HOURS_PER_DAY/
  )
  assert.match(
    script,
    /monthlyInput\.value = formatCalculatedRate\([\s\S]*?hourlyRate \* PAID_HOURS_PER_MONTH/
  )
  assert.match(page, /id="dailyRate"[\s\S]*?readonly/)
  assert.match(page, /id="monthlyRate"[\s\S]*?readonly/)
  assert.match(
    migration,
    /new\.daily_rate := round\(new\.hourly_rate \* 8, 4\)/
  )
  assert.match(
    migration,
    /new\.monthly_rate := round\(new\.hourly_rate \* 176, 4\)/
  )
  assert.match(
    migration,
    /create trigger agent_rates_derive_from_hourly[\s\S]*before insert on public\.agent_rates/
  )
  assert.match(
    migration,
    /revoke all on function public\.payroll_derive_agent_rates_from_hourly\(\)[\s\S]*from public, anon, authenticated/
  )
})

test('agent rates uses the supplied compact card design', async () => {
  const [page, style] = await Promise.all([
    readFile(pageUrl, 'utf8'),
    readFile(styleUrl, 'utf8')
  ])

  assert.match(page, /styles\/agent-rates\.css\?v=7/)
  assert.match(page, /scripts\/agent-rates\.js\?v=5/)
  assert.match(page, /class="rate-metrics"/)
  assert.match(page, /class="rate-conversion-banner unavailable"/)
  assert.match(page, /class="rate-workspace"/)
  assert.match(page, /class="rate-card rate-directory-card"/)
  assert.match(page, /class="rate-card rate-history-card"/)
  assert.doesNotMatch(page, /class="wf-table/)
  assert.match(
    style,
    /\.rate-workspace\s*\{[\s\S]*?grid-template-columns:\s*260px minmax\(0,\s*1fr\)/
  )
  assert.match(
    style,
    /\.rate-metric-card\s*\{[\s\S]*?border-radius:\s*14px[\s\S]*?background:\s*var\(--rate-surface\)/
  )
  assert.match(style, /\.rate-audit-banner\s*\{[\s\S]*?background:\s*#fdf1dc/)
})

test('generated base rates stay blank and aligned until hourly is entered', async () => {
  const [page, script, style] = await Promise.all([
    readFile(pageUrl, 'utf8'),
    readFile(scriptUrl, 'utf8'),
    readFile(styleUrl, 'utf8')
  ])

  assert.match(page, /id="dailyRate"[^>]*placeholder="--"[^>]*readonly/)
  assert.match(page, /id="monthlyRate"[^>]*placeholder="--"[^>]*readonly/)
  assert.doesNotMatch(page, /rate-auto-formula|Automatic: hourly rate/)
  assert.doesNotMatch(style, /\.rate-auto-formula/)
  assert.match(
    script,
    /hourlyInput\.value\.trim\(\) === ''[\s\S]*?dailyInput\.value = ''[\s\S]*?monthlyInput\.value = ''/
  )
  assert.match(script, /if \(payload\.p_hourly_rate === null\)/)
})

test('Agent Rates is reached through the payroll dashboard instead of Home', async () => {
  const [home, page, payrollDashboard] = await Promise.all([
    readFile(homeUrl, 'utf8'),
    readFile(pageUrl, 'utf8'),
    readFile(payrollDashboardUrl, 'utf8')
  ])

  assert.doesNotMatch(home, /homeAgentRatesBtn|href="\.\/agent-rates\.html"/)
  assert.match(home, /scripts\/home-workforce-nav\.js\?v=6/)
  assert.match(
    page,
    /href="\.\/payroll-dashboard\.html">← Back to payroll dashboard<\/a>/
  )
  assert.match(
    payrollDashboard,
    /id="payrollAgentRatesLink"[\s\S]*href="\.\/agent-rates\.html"[\s\S]*hidden/
  )
})
