import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(
  new URL(`../${path}`, import.meta.url),
  'utf8'
)

test('article editor uses shared theme surfaces instead of forced light panels', async () => {
  const [html, toolbar, overrides, imageField, preview, previewV3] =
    await Promise.all([
      read('add-article.html'),
      read('scripts/article-editor-toolbar.js'),
      read('scripts/article-editor-toolbar-overrides.js'),
      read('scripts/article-image-upload.js'),
      read('scripts/article-editor-preview.js'),
      read('scripts/article-editor-preview-v3.js')
    ])

  assert.match(html, /\.article-page \{[\s\S]*background: transparent/)
  assert.match(html, /\.article-card \{[\s\S]*background: var\(--sl-card\)/)
  assert.match(toolbar, /background: var\(--site-surface-solid/)
  assert.match(toolbar, /background: var\(--site-blue-strong/)
  assert.match(overrides, /background: var\(--site-surface-solid/)
  assert.doesNotMatch(overrides, /background: rgba\(255, 255, 255/)
  assert.match(imageField, /::file-selector-button/)
  assert.match(imageField, /background: var\(--site-surface-soft/)
  assert.match(preview, /background: var\(--site-surface-solid/)
  assert.match(preview, /article-image-upload\.js\?v=2/)
  assert.match(previewV3, /article-editor-preview\.js\?v=3/)
  assert.match(previewV3, /article-editor-toolbar-overrides\.js\?v=2/)
})
