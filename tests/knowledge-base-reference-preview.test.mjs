import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(
  new URL(`../${path}`, import.meta.url),
  'utf8'
)

test('internal Knowledge Base links open an accessible article preview', async () => {
  const [page, script] = await Promise.all([
    read('KB.html'),
    read('scripts/kb.js')
  ])

  assert.match(page, /id="articleReferenceDialog"/)
  assert.match(page, /aria-labelledby="articleReferenceTitle"/)
  assert.match(page, /id="articleReferenceSummary"/)
  assert.match(page, /id="viewFullArticleReference"/)
  assert.match(page, /id="openArticleReferenceNewTab"/)
  assert.match(page, /target="_blank"/)
  assert.match(page, /rel="noopener noreferrer"/)
  assert.match(page, /scripts\/kb\.js\?v=14/)

  assert.match(script, /function getInternalArticleReference\(link\)/)
  assert.match(script, /findArticleByRouteValue\(publishedArticles, routeValue\)/)
  assert.match(script, /function openArticleReferencePreview\(reference\)/)
  assert.match(script, /stripInlineFormatting\([\s\S]*article\.description/)
  assert.match(script, /elements\.referenceDialog\.showModal\(\)/)
  assert.match(script, /a\.article-inline-link/)
  assert.match(script, /event\.ctrlKey/)
  assert.match(script, /initializeArticleReferencePreview\(\)/)
})
