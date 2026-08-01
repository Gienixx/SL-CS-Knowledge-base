import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(
  new URL(`../${path}`, import.meta.url),
  'utf8'
)

test('Article Management keeps actions static and scrolls only its compact article list', async () => {
  const page = await read('article-management.html')

  assert.match(page, /\.management-page \{[\s\S]*height: 100dvh;[\s\S]*overflow: hidden;/)
  assert.match(page, /\.management-shell \{[\s\S]*grid-template-rows: auto minmax\(0, 1fr\)/)
  assert.match(page, /\.management-card \{[\s\S]*grid-template-rows: auto auto minmax\(0, 1fr\);[\s\S]*overflow: hidden;/)
  assert.match(page, /\.management-actions \{[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/)
  assert.match(page, /\.article-list \{[\s\S]*overflow-y: auto;[\s\S]*scrollbar-gutter: stable;/)
  assert.match(page, /\.article-list-item \{[\s\S]*padding: 11px 12px;/)
  assert.match(page, /\.article-description \{[\s\S]*-webkit-line-clamp: 2;/)
  assert.match(page, /scripts\/article-management\.js\?v=9/)
})
