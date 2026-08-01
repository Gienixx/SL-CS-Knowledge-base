import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Others contains one categorized Official Links entry', async () => {
  const [page, script] = await Promise.all([
    read('KB.html'),
    read('scripts/kb.js')
  ])

  assert.match(page, /scripts\/kb\.js\?v=16/)
  assert.match(script, /OTHERS:\s*'Others'/)
  assert.doesNotMatch(script, /LINKS:\s*'Links'/)
  assert.match(script, /id: 'official-links'/)
  assert.match(script, /title: 'Official Links'/)
  assert.doesNotMatch(script, /title: 'Demo Compilations'|title: 'Meeting Compilations'/)
  assert.match(script, /title: 'CS Tools'/)
  assert.match(script, /title: 'CS Internal'/)

  for (const label of [
    'Zendesk',
    'Admin Tool',
    'Tremendous',
    'SendGrid',
    'Twilio Error Message',
    'App Demo Recordings',
    'iOS Reviews',
    'Google Play Reviews',
    'Lucid Marketplace Code',
    'Lucid Client Code',
    'Cashout MixPanel',
    'Ticket MixPanel',
    'Demo Compilation',
    'Meeting Compilation',
    'TimeSheet'
  ]) {
    assert.match(script, new RegExp(`label: '${label}'`))
  }

  assert.match(script, /link\.target = '_blank'/)
  assert.match(script, /link\.rel = 'noopener noreferrer'/)
  assert.match(page, /\.official-links-list\{[\s\S]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/)
})
