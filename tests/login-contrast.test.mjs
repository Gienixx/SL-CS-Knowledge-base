import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('dark login theme keeps controls and supporting copy readable', async () => {
  const theme = await read('styles/site-theme.css')
  assert.match(theme, /body:has\(#loginForm\) \.btn-primary[\s\S]*?color: #061323/)
  assert.match(theme, /body:has\(#loginForm\) \.btn-outline[\s\S]*?color: #061323/)
  assert.match(theme, /body:has\(#loginForm\) \.remember[\s\S]*?color: var\(--site-muted\)/)
  assert.match(theme, /body:has\(#loginForm\) \.left p[\s\S]*?color: #c2cada/)
  assert.match(theme, /body:has\(#loginForm\) \.foot-note[\s\S]*?color: var\(--site-muted\)/)
})
