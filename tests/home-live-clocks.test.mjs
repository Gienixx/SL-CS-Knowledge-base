import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Home shows New York and Manila live clocks', async () => {
  const page = await read('home.html')

  assert.match(page, /data-time-zone="America\/New_York"/)
  assert.match(page, /data-time-zone="Asia\/Manila"/)
  assert.match(page, /home-live-clocks\.js\?v=1/)
})

test('hover clocks are alphabetized and backed by daylight-aware zones', async () => {
  const page = await read('home.html')
  const popover = page.match(/<div class="home-timezone-popover"[\s\S]*?<\/div>/)?.[0] || ''

  assert.match(popover, /AEST[\s\S]*BST[\s\S]*CEST[\s\S]*CT[\s\S]*PT/)
  assert.match(popover, /Australia\/Sydney/)
  assert.match(popover, /Europe\/London/)
  assert.match(popover, /Europe\/Paris/)
  assert.match(popover, /America\/Chicago/)
  assert.match(popover, /America\/Los_Angeles/)
})

test('live clock module updates every second with valid JavaScript syntax', async () => {
  const script = await read('scripts/home-live-clocks.js')

  assert.match(script, /new Intl\.DateTimeFormat/)
  assert.match(script, /1000 - \(Date\.now\(\) % 1000\)/)

  const result = spawnSync(process.execPath, ['--check', 'scripts/home-live-clocks.js'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
})
