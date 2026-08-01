import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(
  new URL(`../${path}`, import.meta.url),
  'utf8'
)

test('article editor can insert a published Knowledge Base article by title', async () => {
  const [html, editor, toolbar] = await Promise.all([
    read('add-article.html'),
    read('scripts/add-article.js'),
    read('scripts/article-editor-toolbar.js')
  ])

  assert.match(html, /id="internalArticleLinkDialog"/)
  assert.match(html, /id="internalArticleLinkSelect"/)
  assert.match(html, /scripts\/add-article\.js\?v=14/)
  assert.match(editor, /article-editor-toolbar\.js\?v=6/)
  assert.match(toolbar, /Link selected text to an article or website/)
  assert.doesNotMatch(toolbar, /format: 'article-link'/)
  assert.match(editor, /\.select\('id, title'\)/)
  assert.match(editor, /\.eq\('published', true\)/)
  assert.match(editor, /\.order\('title', \{ ascending: true \}\)/)
  assert.match(editor, /option\.value = getArticleHref\(article\)/)
  assert.match(editor, /internalArticleLinkSelection\.label \|\|[\s\S]*selectedOption\.textContent\.trim\(\)/)
  assert.doesNotMatch(editor, /case 'article-link'/)
})

test('article editor link dialog accepts validated outside links', async () => {
  const [html, editor] = await Promise.all([
    read('add-article.html'),
    read('scripts/add-article.js')
  ])

  assert.match(html, /value="external"/)
  assert.match(html, />\s*Outside link\s*</)
  assert.match(html, /id="externalArticleLinkUrl"/)
  assert.match(html, /id="externalArticleLinkUrl"[\s\S]*type="text"/)
  assert.match(html, /placeholder="https:\/\/example\.com\/help"/)
  assert.match(editor, /openInternalArticleLinkPicker\('external'\)/)
  assert.match(editor, /function getNormalizedExternalLink\(\)/)
  assert.match(editor, /\^https\?:\\\/\\\//)
  assert.match(editor, /Valid outside link\. It will open in a new tab/)
  assert.doesNotMatch(editor, /window\.prompt/)
})
