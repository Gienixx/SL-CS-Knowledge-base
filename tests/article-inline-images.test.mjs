import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(path, 'utf8')

test('article editor uploads accessible inline images through the existing bucket', async () => {
  const [html, editor, toolbar, imageEditor] = await Promise.all([
    read('add-article.html'),
    read('scripts/add-article.js'),
    read('scripts/article-editor-toolbar.js'),
    read('scripts/article-inline-image-editor.js')
  ])

  assert.match(html, /add-article\.js\?v=14/)
  assert.match(toolbar, /format: 'image'/)
  assert.match(toolbar, /Insert an image inside the article/)
  assert.match(editor, /setupInlineArticleImagePicker/)
  assert.match(editor, /case 'image':/)
  assert.match(imageEditor, /uploadArticleImage\(\{/)
  assert.match(imageEditor, /supabase\.auth\.getUser\(\)/)
  assert.match(imageEditor, /Alternative text/)
  assert.match(imageEditor, /Caption/)
  assert.match(imageEditor, /Alignment/)
  assert.match(imageEditor, /Display size/)
  assert.match(imageEditor, /\{align=\$\{alignmentSelect\.value\} width=\$\{widthSelect\.value\}\}/)
  assert.match(imageEditor, /removeArticleImage\(\{ supabase, imagePath: uploadedImagePath \}\)/)
})

test('Knowledge Base and previews safely render inline image metadata', async () => {
  const [page, knowledgeBase, management, preview, renderer] = await Promise.all([
    read('KB.html'),
    read('scripts/kb.js'),
    read('scripts/article-management.js'),
    read('scripts/article-editor-preview-v3.js'),
    read('scripts/article-content-renderer-v8.js')
  ])

  assert.match(page, /scripts\/kb\.js\?v=16/)
  assert.match(knowledgeBase, /article-content-renderer-v8\.js\?v=3/)
  assert.match(management, /article-content-renderer-v8\.js\?v=3/)
  assert.match(preview, /article-content-renderer-v8\.js\?v=3/)
  assert.match(renderer, /function parseInlineImageSyntax\(text\)/)
  assert.match(renderer, /\['http:', 'https:'\]\.includes\(url\.protocol\)/)
  assert.match(renderer, /image\.alt = imageData\.alt/)
  assert.match(renderer, /image\.loading = 'lazy'/)
  assert.match(renderer, /document\.createElement\('figcaption'\)/)
  assert.match(renderer, /article-image-width-(?:small|medium|large|full)/)
})
