import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('landing page keeps all supported apps and dark CTA treatment', async () => {
  const [features, stylesheet, script, indexScript] = await Promise.all([
    read('partials/features.html'),
    read('styles/index-landing.css'),
    read('scripts/supported-apps.js'),
    read('scripts/index.js')
  ])

  assert.match(features, /id="supportedAppsCards"/)
  assert.equal((features.match(/class="landing-card"/g) || []).length, 0)
  assert.match(features, /3 active properties/)
  assert.match(script, /name: 'SurveySpin'/)
  assert.match(indexScript, /renderSupportedApps\(document\.getElementById\('supportedAppsCards'\)\)/)
  const cards = script.match(/name: '(?:Eureka Surveys|SurveyPop|SurveySpin)'/g) || []
  assert.equal(cards.length, 3)
  for (const app of ['Eureka Surveys', 'SurveyPop', 'SurveySpin']) {
    assert.match(script, new RegExp(`name: '${app}'`))
  }
  assert.match(script, /name: 'SurveyPop'[\s\S]*?android[\s\S]*?apple/)
  assert.match(stylesheet, /html\[data-site-theme="dark"\] \.landing-primary\{background:#183452/)
  assert.match(stylesheet, /html\[data-site-theme="dark"\] \.landing-card\{border-color:rgba\(126,158,194,\.2\)/)
})
