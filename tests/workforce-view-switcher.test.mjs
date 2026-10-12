import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Workforce Management uses accessible underline tabs', async () => {
  const page = await read('workforce.html')
  const styles = await read('styles/workforce-admin.css')
  const theme = await read('styles/site-theme.css')

  assert.match(page, /styles\/workforce-admin\.css\?v=15/)
  assert.match(page, /styles\/site-theme\.css\?v=5/)
  assert.match(page, /styles\/workforce-committed-hours\.css\?v=1/)
  assert.match(page, /scripts\/workforce-view-switcher\.js\?v=3/)
  assert.match(page, /class="wf-view-switcher" role="tablist"/)
  assert.match(page, /id="workforceViewButton"[^>]+role="tab"[^>]+aria-selected="true"[^>]+tabindex="0"/)
  assert.match(page, /id="scheduleViewButton"[^>]+role="tab"[^>]+aria-selected="false"[^>]+tabindex="-1"/)
  assert.match(page, /id="workforceView" role="tabpanel"/)
  assert.match(page, /id="scheduleManagementSection" role="tabpanel"/)
  assert.match(page, /id="committedHoursViewButton"[^>]+aria-controls="committedHoursManagementSection"/)
  assert.match(page, /id="committedHoursManagementSection" role="tabpanel"/)
  assert.match(styles, /\.wf-view-switcher\{[^}]*background:transparent/)
  assert.match(styles, /\.wf-view-switcher button\{[^}]*background:transparent!important[^}]*color:var\(--wf-muted\)!important[^}]*box-shadow:none!important/)
  assert.match(styles, /\.wf-view-switcher button:not\(\.active\):hover\{[^}]*border-bottom-color:transparent!important[^}]*color:var\(--wf-navy\)!important[^}]*box-shadow:none!important/)
  assert.match(styles, /\.wf-view-switcher button:not\(\.active\)\{[^}]*border-bottom-color:transparent!important[^}]*color:var\(--wf-muted\)!important/)
  assert.match(styles, /\.wf-view-switcher button\.active,\.wf-view-switcher button\.active:hover\{[^}]*border-bottom-color:var\(--wf-gold\)!important[^}]*background:transparent!important[^}]*box-shadow:none!important/)
  assert.match(theme, /\.wf-view-switcher button\.active,[\s\S]*button\.active:hover \{[\s\S]*border-bottom-color: var\(--site-gold\) !important/)
})

test('Workforce, Schedule, and Committed Hours tabs switch with accessible keyboard controls', async () => {
  const script = await read('scripts/workforce-view-switcher.js')

  assert.match(script, /key: 'committed-hours'/)
  assert.match(script, /view\.panel\.hidden = !active/)
  assert.match(script, /view\.button\.setAttribute\('aria-selected', String\(active\)\)/)
  assert.match(script, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]\.includes\(event\.key\)/)
  assert.match(script, /showManagementView\(nextTab\.key\)/)
  assert.match(script, /nextTab\.button\.focus\(\)/)
})

test('Committed Hours admin controls remain permission gated and use the existing secure RPCs', async () => {
  const [page, script] = await Promise.all([
    read('workforce.html'),
    read('scripts/workforce-committed-hours.js')
  ])

  assert.match(page, /id="addCommittedHoursButton"/)
  assert.match(page, /id="committedHoursModal"/)
  assert.match(page, /src="\.\/scripts\/workforce-committed-hours\.js\?v=1"/)
  assert.match(script, /requireWorkforcePermission\(supabase, 'manage_employees'/)
  assert.match(script, /access\.is_admin !== true/)
  assert.match(script, /'workforce_admin_list_committed_hours'/)
  assert.match(script, /'workforce_admin_save_committed_hours'/)
})
