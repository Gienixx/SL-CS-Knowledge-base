import { supabase } from './supabaseClient.js'
import { createExcerpt, parseArticleContent, renderArticleUnit, stripInlineFormatting } from './article-content-renderer-v7.js?v=1'
import './article-nesting-styles.js?v=1'
import './article-published-parser-styles.js?v=1'

const $ = id => document.getElementById(id)
const elements = { title: $('articleTitle'), tag: $('articleTag'), crumb: $('currentCrumb'), categoryCrumb: $('categoryCrumb'), avatar: $('articleAvatar'), byline: $('articleByline'), cover: $('articleCover'), dek: $('articleDek'), loading: $('loadingSection'), error: $('errorSection'), errorText: $('articleError'), grid: $('contentGrid'), toc: $('tocLinks'), body: $('articleBody'), related: $('relatedArticles') }

function formatDate(value, long = false) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) return 'date unavailable'
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: long ? 'long' : 'short', day: 'numeric' }).format(date)
}

function sectionId(label, index, used) {
  const base = stripInlineFormatting(label).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `section-${index + 1}`
  let id = base
  let suffix = 2
  while (used.has(id)) id = `${base}-${suffix++}`
  used.add(id)
  return id
}

function unitLabel(unit) {
  if (unit.kind === 'step') return `Step ${unit.stepNumber}: ${unit.title}`
  if (unit.kind === 'table') return unit.title || 'Decision Table'
  if (unit.kind === 'callout') return unit.title || 'Important Note'
  return unit.title || 'Article Section'
}

function renderContent(content) {
  const units = parseArticleContent(content)
  const used = new Set()
  elements.toc.replaceChildren()
  elements.body.replaceChildren()
  units.forEach((unit, index) => {
    const label = unitLabel(unit)
    unit.id = sectionId(label, index, used)
    const link = document.createElement('a')
    link.href = `#${unit.id}`
    link.textContent = stripInlineFormatting(label)
    if (index === 0) link.classList.add('active')
    elements.toc.append(link)
    const section = renderArticleUnit(unit)
    section.id = unit.id
    elements.body.append(section)
  })
  if (!units.length) {
    elements.toc.closest('.side-box').hidden = true
    const paragraph = document.createElement('p')
    paragraph.textContent = content || 'This article does not have content yet.'
    elements.body.append(paragraph)
  }
}

async function renderRelated(articleId, tag) {
  const { data, error } = await supabase.from('articles').select('id, title, tag, updated_at, created_at').eq('published', true).eq('tag', tag).neq('id', articleId).order('updated_at', { ascending: false }).limit(3)
  if (error) {
    const fallback = await supabase.from('articles').select('id, title, tag, created_at').eq('published', true).eq('tag', tag).neq('id', articleId).order('created_at', { ascending: false }).limit(3)
    if (fallback.error) throw fallback.error
    return displayRelated(fallback.data || [])
  }
  displayRelated(data || [])
}

function displayRelated(articles) {
  elements.related.replaceChildren()
  if (!articles.length) {
    const empty = document.createElement('span')
    empty.className = 'watch-sub'
    empty.textContent = 'No related articles yet.'
    elements.related.append(empty)
    return
  }
  for (const article of articles) {
    const item = document.createElement('div')
    item.className = 'related-item'
    const link = document.createElement('a')
    link.href = `./article.html?id=${encodeURIComponent(article.id)}`
    link.textContent = article.title
    const meta = document.createElement('span')
    meta.textContent = `${String(article.tag || 'Article').replace(/^./, value => value.toUpperCase())} · updated ${formatDate(article.updated_at || article.created_at)}`
    item.append(link, meta)
    elements.related.append(item)
  }
}

function renderArticle(article, articleId) {
  const title = String(article.title || '').trim() || 'Untitled Article'
  const author = String(article.author_name || '').trim() || 'SocialLoop Customer Support'
  const updater = String(article.updated_by_name || '').trim() || author
  const tag = String(article.tag || 'tickets').trim().toLowerCase()
  const category = tag === 'cashouts' ? 'Cashouts' : 'Tickets'
  const content = String(article.content || '').trim()
  const units = parseArticleContent(content)
  const description = String(article.description || '').trim() || createExcerpt(units, content)
  document.title = `${title} — Knowledge base`
  elements.title.textContent = title
  elements.crumb.textContent = title
  elements.categoryCrumb.textContent = category
  elements.categoryCrumb.href = `./KB.html?category=${encodeURIComponent(category.toUpperCase())}`
  elements.tag.textContent = category
  elements.tag.classList.toggle('cashouts', tag === 'cashouts')
  elements.avatar.textContent = author.charAt(0).toUpperCase() || 'S'
  elements.byline.replaceChildren()
  const authorStrong = document.createElement('b')
  authorStrong.textContent = author
  const updaterStrong = document.createElement('b')
  updaterStrong.textContent = updater
  elements.byline.append(authorStrong, ` · written ${formatDate(article.created_at, true)} · last updated by `, updaterStrong, `, ${formatDate(article.updated_at || article.created_at, true)}`)
  elements.dek.textContent = stripInlineFormatting(description)
  elements.dek.classList.toggle('muted', true)
  if (article.image_url) {
    elements.cover.src = article.image_url
    elements.cover.alt = `${title} cover image`
    elements.cover.hidden = false
    elements.cover.addEventListener('error', () => { elements.cover.hidden = true }, { once: true })
  }
  renderContent(content)
  elements.loading.hidden = true
  elements.error.hidden = true
  elements.grid.hidden = false
  renderRelated(articleId, tag).catch(error => { console.error('Unable to load related articles:', error); displayRelated([]) })
}

function showError(message) {
  document.title = 'Article unavailable — Knowledge base'
  elements.title.textContent = 'Article unavailable'
  elements.loading.hidden = true
  elements.grid.hidden = true
  elements.errorText.textContent = message
  elements.error.hidden = false
}

function initializeInteractions() {
  document.querySelectorAll('.feedback-btns button').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.feedback-btns button').forEach(item => item.classList.toggle('selected', item === button))
    document.querySelector('.feedback-q').textContent = 'Thanks for your feedback.'
  }))
  document.addEventListener('click', event => {
    const link = event.target.closest('.toc a')
    if (!link) return
    document.querySelectorAll('.toc a').forEach(item => item.classList.toggle('active', item === link))
  })
}

async function loadArticle() {
  initializeInteractions()
  const articleId = new URLSearchParams(location.search).get('id')
  if (!articleId) return showError('No article was selected.')
  let result = await supabase.from('articles').select('title, description, content, tag, author_name, image_url, created_at, updated_at, updated_by_name, published').eq('id', articleId).eq('published', true).maybeSingle()
  if (result.error && (result.error.code === '42703' || result.error.code === 'PGRST204')) result = await supabase.from('articles').select('title, description, content, tag, author_name, created_at, published').eq('id', articleId).eq('published', true).maybeSingle()
  if (result.error) return showError(`Unable to load article: ${result.error.message || 'Unknown error'}`)
  if (!result.data) return showError('The requested article could not be found or is not published.')
  renderArticle(result.data, articleId)
}

loadArticle().catch(error => { console.error('Article loading error:', error); showError(`Unable to load article: ${error.message || 'Unknown error'}`) })
