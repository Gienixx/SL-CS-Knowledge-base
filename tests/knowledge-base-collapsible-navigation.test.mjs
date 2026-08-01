import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Knowledge Base uses collapsible category navigation without an All filter', async () => {
  const [page, script] = await Promise.all([
    read('KB.html'),
    read('scripts/kb.js')
  ])

  assert.match(page, /scripts\/kb\.js\?v=16/)
  assert.doesNotMatch(page, /id="kbFilters"|class="filters"/)
  assert.match(page, /id="kbList" class="list" aria-label="Article categories"/)
  assert.match(page, /\.category-toggle\[aria-expanded="true"\]/)
  assert.match(page, /\.category-items\{/)

  assert.doesNotMatch(script, /ALL:\s*'All'/)
  assert.match(script, /let expandedCategories = new Set\(\[activeCategory\]\)/)
  assert.match(script, /function createCategoryGroup\(category, label\)/)
  assert.match(script, /toggle\.setAttribute\('aria-expanded', String\(isExpanded\)\)/)
  assert.match(script, /toggle\.setAttribute\('aria-controls', panelId\)/)
  assert.match(script, /panel\.hidden = !isExpanded/)
  assert.match(script, /expandedCategories\.add\(activeCategory\)/)
  assert.match(script, /renderCategoryNavigation\(\)/)
})
