import { supabase } from './supabaseClient.js'

let databaseArticlesLoaded = false

async function loadDatabaseArticles() {
  if (databaseArticlesLoaded) return

  const { data, error } = await supabase
    .from('articles')
    .select('id, title, content, tag, created_at')
    .eq('published', true)
    .in('tag', ['tickets', 'cashouts'])
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Unable to load articles:', error)
    return
  }

  for (const row of data ?? []) {
    const article = {
      title: row.title,
      description: createExcerpt(row.content),
      status: 'Click here to read.',
      url: `article.html?id=${encodeURIComponent(row.id)}`
    }

    if (row.tag === 'tickets') {
      ticketArticles.unshift(article)
    }

    if (row.tag === 'cashouts') {
      cashoutArticles.unshift(article)
    }
  }

  databaseArticlesLoaded = true
}

function createExcerpt(content, maximumLength = 170) {
  const normalized = String(content ?? '')
    .replace(/\s+/g, ' ')
    .trim()

  if (normalized.length <= maximumLength) {
    return normalized
  }

  return `${normalized.slice(0, maximumLength).trim()}…`
}

async function showTicketsTable(category) {
  const ticketSection = document.getElementById('ticketSection')
  const ticketHeader = document.getElementById('ticketHeader')
  const ticketContent = document.getElementById('ticketContent')

  ticketSection.style.display = 'block'
  ticketHeader.textContent = 'Loading articles...'
  ticketContent.replaceChildren()

  await loadDatabaseArticles()

  if (category === 'TICKETS') {
    ticketHeader.textContent = 'Ticket Articles'
    ticketContent.appendChild(renderArticleGrid(ticketArticles))
  } else if (category === 'CASHOUTS') {
    ticketHeader.textContent = 'Cashout Articles'
    ticketContent.appendChild(renderArticleGrid(cashoutArticles))
  } else {
    renderLinks(category, ticketHeader, ticketContent)
  }

  ticketSection.scrollIntoView({ behavior: 'smooth' })
}

window.showTicketsTable = showTicketsTable
