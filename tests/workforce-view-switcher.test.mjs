import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Workforce Management uses accessible underline tabs', async () => {
  const page = await read('workforce.html')
  const styles = await read('styles/workforce-admin.css')
  const theme = await read('styles/site-theme.css')

  assert.match(page, /styles\/workforce-admin\.css\?v=11/)
  assert.match(page, /styles\/site-theme\.css\?v=2/)
  assert.match(page, /scripts\/workforce-view-switcher\.js\?v=2/)
  assert.match(page, /class="wf-view-switcher" role="tablist"/)
  assert.match(page, /id="workforceViewButton"[^>]+role="tab"[^>]+aria-selected="true"[^>]+tabindex="0"/)
  assert.match(page, /id="scheduleViewButton"[^>]+role="tab"[^>]+aria-selected="false"[^>]+tabindex="-1"/)
  assert.match(page, /id="workforceView" role="tabpanel"/)
  assert.match(page, /id="scheduleManagementSection" role="tabpanel"/)
  assert.match(styles, /\.wf-view-switcher\{[^}]*border-bottom:1px solid var\(--wf-border\)[^}]*background:transparent/)
  assert.match(styles, /\.wf-view-switcher button\{[^}]*color:var\(--wf-muted\)/)
  assert.match(styles, /\.wf-view-switcher button:hover\{[^}]*color:var\(--wf-navy\)/)
  assert.match(styles, /\.wf-view-switcher button:not\(\.active\)\{[^}]*border-bottom-color:transparent/)
  assert.match(styles, /\.wf-view-switcher button\.active\{[^}]*border-bottom-color:var\(--wf-gold\)[^}]*background:transparent/)
  assert.match(theme, /\.wf-view-switcher button\.active \{[\s\S]*border-bottom-color: var\(--site-gold\)/)
})

test('Workforce tabs switch on click and arrow keys', async () => {
  const script = await read('scripts/workforce-view-switcher.js')

  assert.match(script, /workforceView\.hidden = showSchedules/)
  assert.match(script, /scheduleView\.hidden = !showSchedules/)
  assert.match(script, /workforceButton\.tabIndex = showSchedules \? -1 : 0/)
  assert.match(script, /scheduleButton\.tabIndex = showSchedules \? 0 : -1/)
  assert.match(script, /\['ArrowLeft', 'ArrowRight'\]\.includes\(event\.key\)/)
  assert.match(script, /nextTab\.click\(\)/)
  assert.match(script, /nextTab\.focus\(\)/)
})
