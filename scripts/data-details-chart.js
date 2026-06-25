import {
  formatCount,
  formatDate,
  formatShortDate,
  numberOrNull
} from './data-details-utils.js?v=2'

const GRID_STEPS = 4
const MINIMUM_CHART_WIDTH = 680
const WIDTH_PER_DAY = 82

function getVisibleRows(rows) {
  return [...rows].sort((first, second) =>
    String(first.date).localeCompare(String(second.date))
  )
}

function getMaximum(rows, series) {
  return Math.max(
    1,
    ...rows.flatMap(row => series.map(item =>
      Math.max(0, numberOrNull(row[item.key]) || 0)
    ))
  )
}

function createGrid(maximum) {
  const grid = document.createElement('div')
  grid.className = 'vertical-chart-grid'

  for (let index = GRID_STEPS; index >= 0; index -= 1) {
    const value = maximum * (index / GRID_STEPS)
    const row = document.createElement('div')
    row.className = 'vertical-chart-grid-row'

    const label = document.createElement('span')
    label.className = 'vertical-chart-grid-label'
    label.textContent = formatCount(value)

    const line = document.createElement('span')
    line.className = 'vertical-chart-grid-line'

    row.append(label, line)
    grid.appendChild(row)
  }

  return grid
}

function createBar(row, seriesItem, maximum) {
  const value = numberOrNull(row[seriesItem.key])
  const wrapper = document.createElement('div')
  wrapper.className = 'vertical-chart-bar-wrapper'

  const amount = document.createElement('span')
  amount.className = 'vertical-chart-value'
  amount.textContent = formatCount(value)

  const bar = document.createElement('span')
  bar.className = `vertical-chart-bar${
    seriesItem.tone === 'secondary' ? ' secondary' : ''
  }`
  bar.style.height = `${
    value === null
      ? 0
      : Math.max(value > 0 ? 3 : 0, (value / maximum) * 100)
  }%`
  bar.title = `${seriesItem.label}: ${formatCount(value)} on ${formatDate(row.date)}`

  wrapper.append(amount, bar)
  return wrapper
}

function createLegend(series) {
  const legend = document.createElement('div')
  legend.className = 'vertical-chart-legend'

  series.forEach(seriesItem => {
    const item = document.createElement('span')
    item.className = 'vertical-chart-legend-item'

    const marker = document.createElement('i')
    marker.className = `vertical-chart-legend-marker${
      seriesItem.tone === 'secondary' ? ' secondary' : ''
    }`

    const label = document.createElement('span')
    label.textContent = seriesItem.label

    item.append(marker, label)
    legend.appendChild(item)
  })

  return legend
}

export function renderTrendChart(container, titleElement, rows, series) {
  container.replaceChildren()

  if (!Array.isArray(rows) || rows.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'detail-empty'
    empty.textContent = 'No historical data is available for this selection.'
    container.appendChild(empty)
    return
  }

  const visibleRows = getVisibleRows(rows)
  const maximum = getMaximum(visibleRows, series)
  const shell = document.createElement('div')
  shell.className = 'vertical-chart-shell'
  shell.style.minWidth = `${Math.max(
    MINIMUM_CHART_WIDTH,
    visibleRows.length * WIDTH_PER_DAY + 80
  )}px`
  shell.setAttribute('role', 'img')
  shell.setAttribute(
    'aria-label',
    `${titleElement.textContent} vertical bar chart showing ` +
      `${visibleRows.length} reporting days in the selected range`
  )

  const plot = document.createElement('div')
  plot.className = 'vertical-chart-plot'
  plot.appendChild(createGrid(maximum))

  const groups = document.createElement('div')
  groups.className = 'vertical-chart-groups'

  visibleRows.forEach(row => {
    const group = document.createElement('div')
    group.className = 'vertical-chart-group'

    const bars = document.createElement('div')
    bars.className = 'vertical-chart-bars'
    series.forEach(seriesItem => {
      bars.appendChild(createBar(row, seriesItem, maximum))
    })

    const date = document.createElement('span')
    date.className = 'vertical-chart-date'
    date.textContent = formatShortDate(row.date)
    date.title = formatDate(row.date)

    group.append(bars, date)
    groups.appendChild(group)
  })

  plot.appendChild(groups)

  const note = document.createElement('p')
  note.className = 'vertical-chart-range-note'
  note.textContent = `Showing all ${visibleRows.length} reporting days in the selected range.`

  shell.append(plot, createLegend(series), note)
  container.appendChild(shell)
}

export { MINIMUM_CHART_WIDTH, WIDTH_PER_DAY }
