import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = () => readFile(new URL('../admintool.html', import.meta.url), 'utf8')

test('Admin Tool keeps the user summary above the tab switcher', async () => {
  const page = await read()
  const summary = page.match(/<section class="user-summary"[\s\S]*?<\/section>/)?.[0] || ''

  assert.ok(summary)
  assert.ok(page.indexOf('class="user-summary"') < page.indexOf('class="tabbar"'))
  for (const label of [
    'User ID', 'Name', 'Number', 'Lifetime Earnings', 'Lifetime Revenue',
    'Lifetime Profit', 'Lifetime Reconciliation Rate'
  ]) {
    assert.match(summary, new RegExp(label))
  }
  assert.match(summary, /class="user-summary-placeholder"/)
  assert.match(page, /\.user-summary-details\{[\s\S]*grid-template-columns:repeat\(3/)
  assert.match(page, /@media \(max-width:700px\)\{[\s\S]*\.user-summary-details\{ grid-template-columns:repeat\(2/)
  assert.match(page, /\.user-summary\{[\s\S]*margin:12px 16px 0;/)
  assert.match(page, /\.tabbar\{[\s\S]*margin:12px 16px 0;[\s\S]*border:1px solid var\(--border\);[\s\S]*border-radius:8px;/)
})

test('Admin Tool splits Activity into Surveys & Sessions and Offers tabs', async () => {
  const page = await read()
  const tabs = page.match(/\{id:'[^']+', label:'[^']+', key:'\d+'\}/g) || []

  assert.deepEqual(tabs.map(tab => tab.match(/label:'([^']+)'/)?.[1]), [
    'Overview', 'Surveys & Sessions', 'Offers', 'Referrals',
    'Profile & Device', 'Cashouts', 'Transactions', 'Associations', 'Review', 'Action'
  ])
  assert.doesNotMatch(page, /id:'activity'|label:'Activity'/)
  assert.match(page, /'surveys-sessions': \(\) => `[\s\S]*sidePanels\.surveySession\(\)[\s\S]*tableContent\.surveys\(\)/)
  assert.doesNotMatch(page.match(/'surveys-sessions': \(\) => `[\s\S]*?`,\n\n  offers:/)?.[0] || '', /sidePanels\.offers\(\)|tableContent\.offers\(\)/)
  assert.match(page, /offers: \(\) => `[\s\S]*sidePanels\.offers\(\)[\s\S]*tableContent\.offers\(\)/)
})

test('Surveys & Sessions uses one compact summary and keeps Survey History below it', async () => {
  const page = await read()
  const tab = page.match(/'surveys-sessions': \(\) => `[\s\S]*?`,\n\n  offers:/)?.[0] || ''

  assert.match(tab, /class="info-grid surveys-sessions-content"/)
  assert.match(tab, /sidePanels\.surveySession\(\)/)
  assert.doesNotMatch(tab, /sidePanels\.survey\(\)|sidePanels\.sessionQuality\(\)/)
  assert.match(page, /'Survey & Session Summary'[\s\S]*'survey-session-summary'/)
  assert.match(page, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/)
  assert.match(page, /max-height:60vh/)
})

test('Offers and Referrals use compact summaries and Associations splits table space', async () => {
  const page = await read()
  assert.equal((page.match(/compact-metric-card/g) || []).length >= 4, true)
  assert.match(page, /<div class="info-grid compact-tab-content">[\s\S]*sidePanels\.offers\(\)/)
  assert.match(page, /<div class="info-grid compact-tab-content">[\s\S]*sidePanels\.referrals\(\)/)
  assert.match(page, /\.table-content-scroll \.group-section-body\{[\s\S]*overflow:auto/)
  assert.match(page, /\.table-content-scroll thead th\{[\s\S]*position:sticky/)
  assert.doesNotMatch(page, /label:'Finance'|finance: \(\) =>/)
  assert.equal((page.match(/tableContent\.assoccashouts\(\)/g) || []).length, 1)
  assert.equal((page.match(/tableContent\.transactions\(\)/g) || []).length, 1)
  assert.equal((page.match(/tableContent\.assocusers\(\)/g) || []).length, 1)
})

test('Admin Tool summary includes a wrapping verification image carousel', async () => {
  const page = await read()
  assert.match(page, /src="\.\/assets\/dale-garthwaite\.jpg"/)
  assert.match(page, /verificationImages = \[[\s\S]*aisha-tarrant\.jpg/)
  assert.match(page, /aria-label="Previous image"/)
  assert.match(page, /aria-label="Next image"/)
  assert.match(page, /\(nextIndex \+ verificationImages\.length\) % verificationImages\.length/)
  assert.match(page, /event\.key === 'ArrowLeft'/)
  assert.match(page, /event\.key === 'ArrowRight'/)
  assert.match(page, /object-fit:contain/)
  assert.match(page, /grid-template-columns:minmax\(400px,500px\)/)
})
