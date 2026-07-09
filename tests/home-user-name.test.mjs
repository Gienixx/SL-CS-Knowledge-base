import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Home loads the User Management display-name integration', async () => {
  const page = await read('home.html')

  assert.match(page, /home-user-name\.js\?v=1/)
})

test('Home display name comes from login.name and uses only the first name', async () => {
  const script = await read('scripts/home-user-name.js')

  assert.match(script, /\.from\('login'\)/)
  assert.match(script, /\.select\('name, email'\)/)
  assert.match(script, /function getFirstName\(value\)/)
  assert.match(script, /split\(\/\\s\+\/\)/)
  assert.match(script, /homeFirstName/)
  assert.match(script, /homeUserName/)
  assert.match(script, /homeUserAvatar/)
  assert.doesNotMatch(script, /\.insert\(/)
  assert.doesNotMatch(script, /\.update\(/)
  assert.doesNotMatch(script, /\.delete\(/)
})

test('Home User Management display-name script has valid syntax', () => {
  const result = spawnSync(process.execPath, ['--check', 'scripts/home-user-name.js'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
})
