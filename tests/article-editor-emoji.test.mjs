import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(path, 'utf8')

test('article editor offers an emoji picker and supports pasted emojis', async () => {
  const [html, editor, toolbar] = await Promise.all([
    read('add-article.html'),
    read('scripts/add-article.js'),
    read('scripts/article-editor-toolbar.js')
  ])

  assert.match(html, /add-article\.js\?v=14/)
  assert.match(editor, /article-editor-toolbar\.js\?v=6/)
  assert.match(toolbar, /title: 'Insert emoji'/)
  assert.match(toolbar, /className: 'emoji-menu'/)
  assert.match(toolbar, /format: 'emoji:💡'/)
  assert.match(toolbar, /format: 'emoji:✅'/)
  assert.match(editor, /format\.startsWith\('emoji:'\)/)
  assert.match(editor, /insertEmoji\(format\.slice\('emoji:'\.length\)\)/)
  assert.match(editor, /paste any emoji directly/)
})
