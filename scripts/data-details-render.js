import { renderTrendChart } from './data-details-chart.js?v=1'
import {
  formatCount,
  formatDate,
  formatPercentage
} from './data-details-utils.js?v=1'

export function getDetailElements() {
  return {
    page: document.getElementById('detailPage'),
    status: document.getElementById('detailStatus'),
    content: document.getElementById('detailContent'),
    eyebrow: document.getElementById('detailEyebrow'),
    title: document.getElementById('detailTitle'),
    subtitle: document.getElementById('detailSubtitle'),
    summary: document.getElementById('detailSummary'),
    trendTitle: document.getElementById('trendTitle'),
    trendSubtitle: document.getElementById('trendSubtitle'),
    dateBadge: document.getElementById('detailDateBadge'),
    trendChart: document.getElementById('trendChart'),
    secondarySection: document.getElementById('secondarySection'),
    secondaryTitle: document.getElementById('secondaryTitle'),
    secondarySubtitle: document.getElementById('secondarySubtitle'),
    secondaryContent: document.getElementById('secondaryContent'),
    tableTitle: document.getElementById('detailTableTitle'),
    tableSubtitle: document.getElementById('detailTableSubtitle'),
    tableHead: document.getElementById('detailTableHead'),
    tableBody: document.getElementById('detailTableBody'),
    logout: document.getElementById('detailLogoutLink')
  }
}

function renderSummary(elements, cards) {
  elements.summary.replaceChildren()

  cards.forEach(card => {
    const section = document.createElement('section')
    section.className = 'detail-summary-card'

    const label = document.createElement('span')
    label.className = 'detail-summary-label'
    label.textContent = card.label

    const value = document.createElement('strong')
    value.className = 'detail-summary-value'
    value.textContent = card.value

    const help = document.createElement('p')
    help.className = 'detail-summary-help'
    help.textContent = card.help || ''

    section.append(label, value, help)
    elements.summary.appendChild(section)
  })
}

function renderSecondary(elements, secondary) {
  if (!secondary) {
    elements.secondarySection.hidden = true
    elements.secondaryContent.replaceChildren()
    return
  }

  elements.secondarySection.hidden = false
  elements.secondaryTitle.textContent = secondary.title
  elements.secondarySubtitle.textContent = secondary.subtitle
  elements.secondaryContent.replaceChildren()

  if (!secondary.rows.length) {
    const empty = document.createElement('div')
    empty.className = 'detail-empty'
    empty.textContent = 'No concern breakdown is available for the latest date.'
    elements.secondaryContent.appendChild(empty)
    return
  }

  const list = document.createElement('div')
  list.className = 'breakdown-list'

  secondary.rows.forEach(row => {
    const item = document.createElement('div')
    item.className = 'breakdown-row'

    const label = document.createElement('span')
    label.className = 'breakdown-label'
    label.textContent = row.label

    const track = document.createElement('div')
    track.className = 'breakdown-track'
    const bar = document.createElement('span')
    bar.className = 'breakdown-bar'
    bar.style.width = `${Math.max(0, Math.min(100, row.share * 100))}%`
    track.appendChild(bar)

    const values = document.createElement('div')
    values.className = 'breakdown-values'
    const count = document.createElement('strong')
    count.textContent = formatCount(row.value)
    const share = document.createElement('span')
    share.textContent = formatPercentage(row.share)
    values.append(count, share)

    item.append(label, track, values)
    list.appendChild(item)
  })

  elements.secondaryContent.appendChild(list)
}

function renderTable(elements, columns, rows) {
  elements.tableHead.replaceChildren()
  elements.tableBody.replaceChildren()

  const headerRow = document.createElement('tr')
  columns.forEach(column => {
    const cell = document.createElement('th')
    cell.scope = 'col'
    cell.textContent = column.label
    if (column.numeric) cell.classList.add('numeric')
    headerRow.appendChild(cell)
  })
  elements.tableHead.appendChild(headerRow)

  if (!rows.length) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = Math.max(1, columns.length)
    cell.className = 'detail-table-empty'
    cell.textContent = 'No detailed records are available.'
    row.appendChild(cell)
    elements.tableBody.appendChild(row)
    return
  }

  rows.forEach(values => {
    const row = document.createElement('tr')

    values.forEach((value, index) => {
      const cell = document.createElement('td')
      cell.textContent = value
      if (columns[index]?.numeric) cell.classList.add('numeric')
      row.appendChild(cell)
    })

    elements.tableBody.appendChild(row)
  })
}

export function renderModel(elements, model) {
  elements.eyebrow.textContent = model.eyebrow
  elements.title.textContent = model.title
  elements.subtitle.textContent = model.subtitle
  elements.trendTitle.textContent = model.trendTitle
  elements.trendSubtitle.textContent = model.trendSubtitle
  elements.dateBadge.textContent = model.latestDate
    ? formatDate(model.latestDate)
    : 'No data'
  elements.tableTitle.textContent = model.tableTitle
  elements.tableSubtitle.textContent = model.tableSubtitle
  document.title = `${model.title} | SocialLoop CS Base`

  renderSummary(elements, model.summaryCards)
  renderTrendChart(
    elements.trendChart,
    elements.trendTitle,
    model.trendRows,
    model.trendSeries
  )
  renderSecondary(elements, model.secondary)
  renderTable(elements, model.tableColumns, model.tableRows)

  elements.status.hidden = true
  elements.content.hidden = false
  elements.page.setAttribute('aria-busy', 'false')
}

export function showError(elements, error) {
  console.error('Unable to load detail page:', error)
  elements.content.hidden = true
  elements.status.hidden = false
  elements.status.className = 'detail-status detail-status-error'
  elements.status.replaceChildren()

  const heading = document.createElement('h2')
  heading.textContent = 'Unable to load this detail view'
  const message = document.createElement('p')
  message.textContent = error?.message ||
    'The requested dashboard data could not be loaded.'
  const link = document.createElement('a')
  link.className = 'detail-status-link'
  link.href = './dashboard.html'
  link.textContent = 'Return to Dashboard'

  elements.status.append(heading, message, link)
  elements.page.setAttribute('aria-busy', 'false')
}
