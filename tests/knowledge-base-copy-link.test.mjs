import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('published Knowledge Base articles expose a canonical copy-link action', async () => {
  const [page, script] = await Promise.all([
    read('KB.html'),
    read('scripts/kb.js')
  ])

  assert.match(page, /scripts\/kb\.js\?v=14/)
  assert.match(page, /\.article-title-row/)
  assert.match(page, /\.article-copy-button/)
  assert.match(page, /article-copy-button:focus-visible/)
  assert.match(page, /@media\(max-width:420px\)/)

  assert.match(script, /function createCopyArticleLinkButton\(article\)/)
  assert.match(script, /getArticleHref\(article\)/)
  assert.match(script, /navigator\.clipboard\?\.writeText/)
  assert.match(script, /document\.execCommand\('copy'\)/)
  assert.match(script, /label\.textContent = 'Copied'/)
  assert.match(script, /label\.textContent = 'Copy failed'/)
  assert.match(script, /titleRow\.append\(title, createCopyArticleLinkButton\(item\)\)/)
})
