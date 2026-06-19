import { supabase } from './supabaseClient.js'

const links = {
  LINKS: [
    {
      name: 'Demo Compilations',
      url:
        'https://drive.google.com/drive/folders/' +
        '1-XRG19rNkVpaG75W9puN3CNiJVJKlQYX'
    },
    {
      name: 'Meeting Compilations',
      url:
        'https://drive.google.com/drive/folders/' +
        '1nt6ozbXVdq-lhA9MVSXnsm6Bt50Hdrx5?usp=sharing'
    }
  ]
}

const cashoutArticles = [
  {
    title: 'Cashout Review Checklist',
    description:
      'A quick guide for checking payout requests before they are approved.',
    status: 'Click here to read.',
    url: 'https://example.com/cashout-review-checklist'
  },
  {
    title: 'Fraud Pattern Indicators',
    description:
      'Common red flags that help you spot suspicious cashout activity earlier.',
    status: 'Click here to read.',
    url: 'https://example.com/fraud-pattern-indicators'
  },
  {
    title: 'Escalation Rules for Cashouts',
    description:
      'When to pause a payout and send it to a lead or fraud reviewer.',
    status: 'Ready for article'
  },
  {
    title: 'Payment Validation Notes',
    description:
      'Reference points for confirming payment details and avoiding processing errors.',
    status: 'Ready for article'
  }
]

const ticketArticles = [
  {
    title: 'Navigating and Reviewing Tickets in Zendesk',
    description:
      'Guide on how to locate and understand how Zendesk works.',
    status: 'Click here to read.',
    image: './assets/article1.png',
    url: './articles/article1.html'
  },
  {
    title: '4 Brilliant Tips for Dealing with Angry Customers',
    description:
      'Angry customers are one of the hardest parts of support work. ' +
      'Small things, like using a customer’s name, can shift the whole tone.',
    status: 'Click here to read.',
    image: './assets/article2.png',
    url: './articles/article2.html'
  },
  {
    title: 'Not Rewarded',
    description:
      'How to identify, review, and resolve tickets from users who report ' +
      'they were not rewarded after completing a survey.',
    status: 'Click here to read.',
    url: './articles/article3.html'
  },
  {
    title: 'Escalation Process',
    description:
      'Placeholder for when and how support tickets should be escalated.',
    status: 'Ready for article'
  },
  {
    title: 'Slack Communication',
    description:
      'Placeholder for internal Slack channels, updates, and support coordination.',
    status: 'Ready for article'
  },
  {
    title: 'Quality Checklist',
    description:
      'Placeholder for final checks before marking a ticket solved.',
    status: 'Ready for article'
  }
]

let databaseArticlesLoaded = false

async function loadDatabaseArticles() {
  if (databaseArticlesLoaded) {
    return
  }

  const { data, error } = await supabase
    .from('articles')
    .select(
      'id, title, description, content, tag, author_name, published'
    )
    .eq('published', true)

  if (error) {
    throw error
  }

  const databaseRows = Array.isArray(data)
    ? [...data].reverse()
    : []

  for (const row of databaseRows) {
    const normalizedTag = String(row.tag ?? '')
      .trim()
      .toLowerCase()

    if (
      normalizedTag !== 'tickets' &&
      normalizedTag !== 'cashouts'
    ) {
      continue
    }

    const article = {
      title: row.title || 'Untitled Article',
      description:
        String(row.description ?? '').trim() ||
        createExcerpt(row.content),
      status: row.author_name
        ? `Written by ${row.author_name}`
        : 'Click here to read.',
      url: `./article.html?id=${encodeURIComponent(row.id)}`
    }

    if (normalizedTag === 'tickets') {
      ticketArticles.unshift(article)
    }

    if (normalizedTag === 'cashouts') {
      cashoutArticles.unshift(article)
    }
  }

  databaseArticlesLoaded = true
}

function createExcerpt(content, maximumLength = 170) {
  const normalized = String(content ?? '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return 'Open this article to read more.'
  }

  if (normalized.length <= maximumLength) {
    return normalized
  }

  return `${normalized.slice(0, maximumLength).trim()}…`
}

function renderArticleGrid(articles) {
  const grid = document.createElement('div')
  grid.className = 'article-grid'

  if (!articles.length) {
    const emptyMessage = document.createElement('p')

    emptyMessage.textContent =
      'No published articles are available in this category.'

    grid.appendChild(emptyMessage)
    return grid
  }

  for (const article of articles) {
    const card = document.createElement('article')
    card.className = 'article-card'

    const wrapper = article.url
      ? document.createElement('a')
      : document.createElement('div')

    if (article.url) {
      wrapper.href = article.url
      wrapper.style.display = 'block'
      wrapper.style.color = 'inherit'
      wrapper.style.textDecoration = 'none'
    }

    if (article.image) {
      const image = document.createElement('img')

      image.src = article.image
      image.alt = article.title
      image.style.width = '100%'
      image.style.height = '145px'
      image.style.objectFit = 'cover'
      image.style.display = 'block'

      wrapper.appendChild(image)
    } else {
      const placeholder = document.createElement('div')

      placeholder.className = 'article-image-placeholder'
      placeholder.textContent = 'Knowledge Base Article'

      wrapper.appendChild(placeholder)
    }

    const contentContainer = document.createElement('div')
    contentContainer.className = 'article-content'

    const title = document.createElement('h3')
    title.textContent = article.title

    const description = document.createElement('p')
    description.textContent = article.description

    const status = document.createElement('div')
    status.className = 'article-meta'
    status.textContent = article.status

    contentContainer.append(
      title,
      description,
      status
    )

    wrapper.appendChild(contentContainer)
    card.appendChild(wrapper)
    grid.appendChild(card)
  }

  return grid
}

function renderLinks(
  category,
  ticketHeader,
  ticketContent
) {
  ticketHeader.textContent = 'Useful Links'

  const table = document.createElement('table')
  const tableHead = document.createElement('thead')
  const headingRow = document.createElement('tr')

  const nameHeading = document.createElement('th')
  nameHeading.textContent = 'Name'

  const linkHeading = document.createElement('th')
  linkHeading.textContent = 'Link'

  headingRow.append(nameHeading, linkHeading)
  tableHead.appendChild(headingRow)

  const tableBody = document.createElement('tbody')
  const categoryLinks = links[category] ?? []

  for (const item of categoryLinks) {
    const row = document.createElement('tr')

    const nameCell = document.createElement('td')
    nameCell.textContent = item.name

    const linkCell = document.createElement('td')
    const link = document.createElement('a')

    link.href = item.url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = 'Open Link'

    linkCell.appendChild(link)
    row.append(nameCell, linkCell)
    tableBody.appendChild(row)
  }

  table.append(tableHead, tableBody)
  ticketContent.appendChild(table)
}

async function showTicketsTable(category) {
  const ticketSection =
    document.getElementById('ticketSection')

  const ticketHeader =
    document.getElementById('ticketHeader')

  const ticketContent =
    document.getElementById('ticketContent')

  if (
    !ticketSection ||
    !ticketHeader ||
    !ticketContent
  ) {
    console.error('Knowledge base display elements were not found.')
    return
  }

  const normalizedCategory = String(category)
    .trim()
    .toUpperCase()

  ticketSection.style.display = 'block'
  ticketContent.replaceChildren()

  try {
    if (
      normalizedCategory === 'TICKETS' ||
      normalizedCategory === 'CASHOUTS'
    ) {
      ticketHeader.textContent = 'Loading articles...'

      await loadDatabaseArticles()
    }

    if (normalizedCategory === 'TICKETS') {
      ticketHeader.textContent = 'Ticket Articles'

      ticketContent.appendChild(
        renderArticleGrid(ticketArticles)
      )
    } else if (normalizedCategory === 'CASHOUTS') {
      ticketHeader.textContent = 'Cashout Articles'

      ticketContent.appendChild(
        renderArticleGrid(cashoutArticles)
      )
    } else if (normalizedCategory === 'LINKS') {
      renderLinks(
        normalizedCategory,
        ticketHeader,
        ticketContent
      )
    } else {
      ticketHeader.textContent = 'Category unavailable'

      const message = document.createElement('p')
      message.textContent =
        'The selected knowledge base category does not exist.'

      ticketContent.appendChild(message)
    }
  } catch (error) {
    console.error(
      'Unable to load knowledge base articles:',
      error
    )

    ticketHeader.textContent = 'Unable to load articles'

    const errorMessage = document.createElement('p')
    errorMessage.className = 'load-error'

    errorMessage.textContent =
      `Supabase error: ${error.message || 'Unknown error'}`

    ticketContent.appendChild(errorMessage)
  }

  ticketSection.scrollIntoView({
    behavior: 'smooth',
    block: 'start'
  })
}

function goToLanding() {
  window.location.href = './index-modular.html'
}

window.showTicketsTable = showTicketsTable
window.goToLanding = goToLanding

document.addEventListener('DOMContentLoaded', () => {
  const searchInput =
    document.getElementById('searchInput')

  const cards =
    document.querySelectorAll('.cards .card')

  if (!searchInput) {
    return
  }

  searchInput.addEventListener('input', () => {
    const query = searchInput.value
      .toLowerCase()
      .trim()

    cards.forEach(card => {
      const cardText = card.textContent
        .toLowerCase()

      card.style.display =
        cardText.includes(query)
          ? 'block'
          : 'none'
    })
  })
})
