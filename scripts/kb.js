import { supabase } from './supabaseClient.js'

const usefulLinks = [
  { title: 'Demo Compilations', subtitle: 'Video demos and walkthroughs', url: 'https://drive.google.com/drive/folders/1-XRG19rNkVpaG75W9puN3CNiJVJKlQYX', gradient: 'linear-gradient(135deg,#EAEAF7,#D8D6EF)' },
  { title: 'Meeting Compilations', subtitle: 'Recorded team meetings', url: 'https://drive.google.com/drive/folders/1nt6ozbXVdq-lhA9MVSXnsm6Bt50Hdrx5?usp=sharing', gradient: 'linear-gradient(135deg,#FBEDDA,#F3D9AE)' }
]

let publishedArticles = []
let activeCategory = 'ALL'
let searchQuery = ''

function missingImageColumn(error) {
  const message = String(error?.message || '').toLowerCase()
  return error?.code === '42703' || error?.code === 'PGRST204' || message.includes('image_url')
}

async function fetchArticles() {
  let result = await supabase.from('articles').select('id, title, description, content, tag, author_name, image_url, published, created_at').eq('published', true).order('created_at', { ascending: false })
  if (result.error && missingImageColumn(result.error)) {
    result = await supabase.from('articles').select('id, title, description, content, tag, author_name, published, created_at').eq('published', true).order('created_at', { ascending: false })
  }
  if (result.error) throw result.error
  return Array.isArray(result.data) ? result.data.map(mapArticle).filter(Boolean) : []
}

function mapArticle(row) {
  const category = String(row.tag || '').trim().toLowerCase()
  if (!['tickets', 'cashouts'].includes(category)) return null
  const rawContent = String(row.content || '').replace(/:::[^\n]*/g, ' ').replace(/[#>*|\-]/g, ' ').replace(/\s+/g, ' ').trim()
  const description = String(row.description || '').trim() || (rawContent ? `${rawContent.slice(0, 165)}${rawContent.length > 165 ? '…' : ''}` : 'Open this article to read more.')
  const date = row.created_at && !Number.isNaN(new Date(row.created_at).getTime()) ? new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(row.created_at)) : ''
  const author = String(row.author_name || '').trim()
  return { id: row.id, title: String(row.title || '').trim() || 'Untitled Article', description, category, author, date, search: `${row.title || ''} ${description} ${row.content || ''} ${author} ${category}`.toLowerCase() }
}

function articleCard(article) {
  const link = document.createElement('a')
  link.className = 'art-card'
  link.href = `./article.html?id=${encodeURIComponent(article.id)}`
  const tag = document.createElement('span')
  tag.className = `art-tag ${article.category}`
  tag.textContent = article.category === 'cashouts' ? 'Cashouts' : 'Tickets'
  const title = document.createElement('p')
  title.className = 'art-title'
  title.textContent = article.title
  const description = document.createElement('p')
  description.className = 'art-desc'
  description.textContent = article.description
  const meta = document.createElement('p')
  meta.className = 'art-meta'
  const author = document.createElement('b')
  author.textContent = article.author || 'Support team'
  meta.append(author)
  if (article.date) meta.append(` · ${article.date}`)
  link.append(tag, title, description, meta)
  return link
}

function renderArticles() {
  const grid = document.getElementById('articles')
  const count = document.getElementById('articleCount')
  const heading = document.querySelector('#articleHeading .section-title')
  const query = searchQuery.trim().toLowerCase()
  const filtered = publishedArticles.filter(article => (activeCategory === 'ALL' || article.category === activeCategory.toLowerCase()) && (!query || article.search.includes(query)))
  grid.replaceChildren(...filtered.map(articleCard))
  if (!filtered.length) {
    const empty = document.createElement('p')
    empty.className = 'empty-state'
    empty.textContent = query ? 'No articles match your search.' : 'No published articles are available in this category yet.'
    grid.append(empty)
  }
  heading.textContent = query ? `Search results for “${searchQuery.trim()}”` : activeCategory === 'ALL' ? 'All published articles' : `${activeCategory[0]}${activeCategory.slice(1).toLowerCase()} articles`
  count.textContent = `${filtered.length} ${filtered.length === 1 ? 'article' : 'articles'}${activeCategory === 'ALL' ? '' : ` · filtered by ${activeCategory[0]}${activeCategory.slice(1).toLowerCase()}`}`
}

function renderLinks() {
  const grid = document.getElementById('watchGrid')
  grid.replaceChildren(...usefulLinks.map(item => {
    const card = document.createElement('a')
    card.className = 'watch-card'
    card.href = item.url
    card.target = '_blank'
    card.rel = 'noopener noreferrer'
    card.innerHTML = `<div class="thumb" style="background:${item.gradient}"><span class="play"></span></div><div class="watch-label"><p class="watch-title"></p><p class="watch-sub"></p></div>`
    card.querySelector('.watch-title').textContent = item.title
    card.querySelector('.watch-sub').textContent = item.subtitle
    return card
  }))
}

function setCategory(category) {
  activeCategory = category
  document.querySelectorAll('.filter-chip').forEach(button => button.classList.toggle('on', button.dataset.category === category))
  const linksOnly = category === 'LINKS'
  document.getElementById('articleHeading').hidden = linksOnly
  document.getElementById('articles').hidden = linksOnly
  document.getElementById('watchSection').hidden = !linksOnly && Boolean(searchQuery.trim())
  if (!linksOnly) renderArticles()
  if (linksOnly) document.getElementById('watchSection').hidden = false
}

document.addEventListener('DOMContentLoaded', async () => {
  renderLinks()
  document.querySelectorAll('.filter-chip').forEach(button => button.addEventListener('click', () => setCategory(button.dataset.category)))
  const search = document.getElementById('searchInput')
  search.addEventListener('input', () => {
    searchQuery = search.value
    if (activeCategory === 'LINKS') setCategory('ALL')
    else setCategory(activeCategory)
  })
  try {
    publishedArticles = await fetchArticles()
    renderArticles()
  } catch (error) {
    console.error('Unable to load knowledge base articles:', error)
    const message = document.createElement('p')
    message.className = 'load-error'
    message.textContent = 'Unable to load published articles. Please try again later.'
    document.getElementById('articles').replaceChildren(message)
    document.getElementById('articleCount').textContent = 'Articles unavailable'
  }
})
