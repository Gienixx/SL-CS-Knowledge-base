import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Knowledge Base supports direct section links after asynchronous rendering', async () => {
  const [page, script] = await Promise.all([
    read('KB.html'),
    read('scripts/kb.js')
  ])

  assert.match(page, /scripts\/kb\.js\?v=16/)
  assert.match(page, /\.article-section-heading\{scroll-margin-top:24px\}/)
  assert.match(page, /\.article-section-heading:target/)

  assert.match(script, /container\.querySelectorAll\('h2, h3'\)/)
  assert.match(script, /getArticleSectionIds/)
  assert.match(script, /article-route\.js\?v=2/)
  assert.match(script, /`\$\{url\.pathname\}\$\{url\.search\}\$\{url\.hash\}`/)
  assert.match(script, /heading\.id = sectionIds\[index\]/)
  assert.match(script, /decodeURIComponent\(window\.location\.hash\.slice\(1\)\)/)
  assert.match(script, /section\.scrollIntoView\(\{ behavior, block: 'start' \}\)/)
  assert.match(script, /section: window\.location\.hash/)
  assert.match(script, /window\.addEventListener\('hashchange', scrollToRequestedArticleSection\)/)
})
