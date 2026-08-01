import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const read = path => readFile(
  new URL(`../${path}`, import.meta.url),
  'utf8'
)

test('article link normalization accepts safe destinations only', async () => {
  const source = await read('scripts/article-link-utils.js')
  const moduleUrl =
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  const {
    findArticleLinks,
    normalizeArticleLinkHref,
    tokenizeArticleLinks
  } = await import(moduleUrl)

  assert.equal(
    normalizeArticleLinkHref('example.com/help'),
    'https://example.com/help'
  )
  assert.equal(
    normalizeArticleLinkHref('https://example.com/help'),
    'https://example.com/help'
  )
  assert.equal(normalizeArticleLinkHref('./KB.html?article=1'), './KB.html?article=1')
  assert.equal(normalizeArticleLinkHref('#article-map'), '#article-map')
  assert.equal(normalizeArticleLinkHref('article.html'), '')
  assert.equal(normalizeArticleLinkHref('supabaseClient.js'), '')
  assert.equal(normalizeArticleLinkHref('javascript:alert(1)'), '')
  assert.equal(normalizeArticleLinkHref('data:text/html,test'), '')

  assert.deepEqual(
    tokenizeArticleLinks(
      'Read https://example.com/help, then [open support](support.example.com).'
    ),
    [
      { type: 'text', text: 'Read ' },
      {
        type: 'link',
        label: 'https://example.com/help',
        href: 'https://example.com/help'
      },
      { type: 'text', text: ', then ' },
      {
        type: 'link',
        label: 'open support',
        href: 'https://support.example.com/'
      },
      { type: 'text', text: '.' }
    ]
  )

  assert.deepEqual(
    findArticleLinks(
      'Go to https://login.sendgrid.com/login/ and continue.'
    ),
    [
      {
        start: 6,
        end: 39,
        label: 'https://login.sendgrid.com/login/',
        href: 'https://login.sendgrid.com/login/',
        customLabel: false
      }
    ]
  )

  assert.deepEqual(
    tokenizeArticleLinks(
      'Email user@example.com and open client.js.'
    ),
    [
      {
        type: 'text',
        text: 'Email user@example.com and open client.js.'
      }
    ]
  )
})

test('article editor and shared renderer expose link authoring', async () => {
  const [editor, toolbar, renderer, preview, knowledgeBase] =
    await Promise.all([
      read('scripts/add-article.js'),
      read('scripts/article-editor-toolbar.js'),
      read('scripts/article-content-renderer-v8.js'),
      read('scripts/article-editor-preview-v3.js'),
      read('scripts/kb.js')
    ])

  assert.match(toolbar, /format: 'link'/)
  assert.doesNotMatch(toolbar, /format: 'article-link'/)
  assert.match(editor, /case 'link':\s+insertLink\(\)/)
  assert.match(editor, /openInternalArticleLinkPicker\('external'\)/)
  assert.doesNotMatch(editor, /case 'article-link'/)
  assert.match(editor, /pressedKey === 'k'/)
  assert.match(renderer, /findArticleLinks/)
  assert.match(renderer, /document\.createRange\(\)/)
  assert.match(renderer, /noopener noreferrer/)
  assert.match(preview, /article-content-renderer-v8\.js/)
  assert.match(knowledgeBase, /article-content-renderer-v8\.js/)
})
