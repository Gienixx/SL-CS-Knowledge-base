import {
  formatAht,
  formatCount,
  formatDate,
  formatShortDate,
  numberOrNull
} from './data-details-utils.js?v=2'

const SVG_NS = 'http://www.w3.org/2000/svg'
const GRID_STEPS = 4
const MINIMUM_CHART_WIDTH = 680
const WIDTH_PER_DAY = 44
const CHART_HEIGHT = 340
const MARGIN = Object.freeze({
  top: 24,
  right: 28,
  bottom: 58,
  left: 66
})

function createSvgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name)

  Object.entries(attributes).forEach(([key, value]) => {
    element.setAttribute(key, String(value))
  })

  return element
}

function getVisibleRows(rows) {
  return [...rows].sort((first, second) =>
    String(first.date).localeCompare(String(second.date))
  )
}

function getValidValues(rows, series) {
  return rows.flatMap(row => series.flatMap(item => {
    const value = numberOrNull(row[item.key])
    return value === null || value < 0 ? [] : [value]
  }))
}

function getNiceMaximum(rawMaximum) {
  if (!Number.isFinite(rawMaximum) || rawMaximum <= 0) return 1

  const magnitude = 10 ** Math.floor(Math.log10(rawMaximum))
  const normalized = rawMaximum / magnitude
  const rounded = normalized <= 1
    ? 1
    : normalized <= 2
      ? 2
      : normalized <= 5
        ? 5
        : 10

  return rounded * magnitude
}

function formatSeriesValue(seriesItem, value) {
  return seriesItem.format === 'aht'
    ? formatAht(value)
    : formatCount(value)
}

function getToneClass(seriesItem) {
  if (seriesItem.tone === 'secondary') return 'secondary'
  if (seriesItem.tone === 'tertiary') return 'tertiary'
  return 'primary'
}

function getTickIndexes(rowCount) {
  const tickCount = Math.min(7, rowCount)
  const indexes = new Set()

  for (let index = 0; index < tickCount; index += 1) {
    indexes.add(
      tickCount === 1
        ? 0
        : Math.round((index / (tickCount - 1)) * (rowCount - 1))
    )
  }

  return [...indexes]
}

function buildSegments(rows, seriesItem, xForIndex, yForValue) {
  const segments = []
  let current = []

  const flush = () => {
    if (current.length > 0) segments.push(current)
    current = []
  }

  rows.forEach((row, index) => {
    const value = numberOrNull(row[seriesItem.key])

    if (value === null || value < 0) {
      flush()
      return
    }

    current.push({
      x: xForIndex(index),
      y: yForValue(value)
    })
  })

  flush()
  return segments
}

function createLegend(series) {
  const legend = document.createElement('div')
  legend.className = 'line-chart-legend'

  series.forEach(seriesItem => {
    const item = document.createElement('span')
    item.className = 'line-chart-legend-item'

    const marker = document.createElement('i')
    marker.className = `line-chart-legend-marker ${getToneClass(seriesItem)}`

    const label = document.createElement('span')
    label.textContent = seriesItem.label

    item.append(marker, label)
    legend.appendChild(item)
  })

  return legend
}

function createAccessibleSummary(rows, series) {
  const list = document.createElement('ul')
  list.className = 'chart-data-summary'

  rows.forEach(row => {
    const item = document.createElement('li')
    const values = series.map(seriesItem => {
      const value = numberOrNull(row[seriesItem.key])
      return `${seriesItem.label}: ${formatSeriesValue(seriesItem, value)}`
    })

    item.textContent = `${formatDate(row.date)} — ${values.join(', ')}`
    list.appendChild(item)
  })

  return list
}

export function renderTrendChart(container, titleElement, rows, series) {
  container.replaceChildren()

  const visibleRows = Array.isArray(rows) ? getVisibleRows(rows) : []
  const validValues = getValidValues(visibleRows, series)

  if (visibleRows.length === 0 || validValues.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'detail-empty'
    empty.textContent = 'No historical data is available for this selection.'
    container.appendChild(empty)
    return
  }

  const chartWidth = Math.max(
    MINIMUM_CHART_WIDTH,
    visibleRows.length * WIDTH_PER_DAY + MARGIN.left + MARGIN.right
  )
  const plotWidth = chartWidth - MARGIN.left - MARGIN.right
  const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom
  const maximum = getNiceMaximum(Math.max(...validValues))
  const axisSeries = series[0]
  const shell = document.createElement('div')
  shell.className = 'line-chart-shell'
  shell.style.width = `${chartWidth}px`

  const svg = createSvgElement('svg', {
    class: 'line-chart-svg',
    viewBox: `0 0 ${chartWidth} ${CHART_HEIGHT}`,
    role: 'img',
    'aria-label':
      `${titleElement.textContent} historical line chart with ` +
      `${visibleRows.length} reporting days`
  })

  const xForIndex = index => visibleRows.length === 1
    ? MARGIN.left + plotWidth / 2
    : MARGIN.left + (index / (visibleRows.length - 1)) * plotWidth
  const yForValue = value =>
    MARGIN.top + plotHeight - (value / maximum) * plotHeight

  for (let index = 0; index <= GRID_STEPS; index += 1) {
    const ratio = index / GRID_STEPS
    const y = MARGIN.top + plotHeight - ratio * plotHeight
    const value = maximum * ratio

    svg.appendChild(createSvgElement('line', {
      x1: MARGIN.left,
      x2: chartWidth - MARGIN.right,
      y1: y,
      y2: y,
      class: 'line-chart-grid-line'
    }))

    const label = createSvgElement('text', {
      x: MARGIN.left - 10,
      y: y + 4,
      'text-anchor': 'end',
      class: 'line-chart-axis-label'
    })
    label.textContent = formatSeriesValue(axisSeries, value)
    svg.appendChild(label)
  }

  svg.appendChild(createSvgElement('line', {
    x1: MARGIN.left,
    x2: MARGIN.left,
    y1: MARGIN.top,
    y2: MARGIN.top + plotHeight,
    class: 'line-chart-axis-line'
  }))
  svg.appendChild(createSvgElement('line', {
    x1: MARGIN.left,
    x2: chartWidth - MARGIN.right,
    y1: MARGIN.top + plotHeight,
    y2: MARGIN.top + plotHeight,
    class: 'line-chart-axis-line'
  }))

  getTickIndexes(visibleRows.length).forEach(index => {
    const x = xForIndex(index)
    const label = createSvgElement('text', {
      x,
      y: CHART_HEIGHT - 22,
      'text-anchor': 'middle',
      class: 'line-chart-axis-label'
    })
    label.textContent = formatShortDate(visibleRows[index].date)
    svg.appendChild(label)
  })

  series.forEach(seriesItem => {
    const tone = getToneClass(seriesItem)
    const segments = buildSegments(
      visibleRows,
      seriesItem,
      xForIndex,
      yForValue
    )

    segments.forEach(segment => {
      if (segment.length < 2) return

      const path = createSvgElement('path', {
        d: segment
          .map((point, index) =>
            `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
          )
          .join(' '),
        class: `line-chart-line ${tone}`
      })
      svg.appendChild(path)
    })

    visibleRows.forEach((row, index) => {
      const value = numberOrNull(row[seriesItem.key])
      if (value === null || value < 0) return

      const point = createSvgElement('circle', {
        cx: xForIndex(index),
        cy: yForValue(value),
        r: 4.5,
        class: `line-chart-point ${tone}`,
        tabindex: 0,
        role: 'img',
        'aria-label':
          `${seriesItem.label} ${formatSeriesValue(seriesItem, value)} ` +
          `on ${formatDate(row.date)}`
      })
      const title = createSvgElement('title')
      title.textContent =
        `${seriesItem.label}: ${formatSeriesValue(seriesItem, value)} ` +
        `on ${formatDate(row.date)}`
      point.appendChild(title)
      svg.appendChild(point)
    })
  })

  const note = document.createElement('p')
  note.className = 'line-chart-range-note'
  note.textContent =
    `Showing ${visibleRows.length} reporting ` +
    `${visibleRows.length === 1 ? 'day' : 'days'} from ` +
    `${formatDate(visibleRows[0].date)} through ` +
    `${formatDate(visibleRows[visibleRows.length - 1].date)}.`

  shell.append(svg, createLegend(series), note, createAccessibleSummary(visibleRows, series))
  container.appendChild(shell)
}

export { MINIMUM_CHART_WIDTH, WIDTH_PER_DAY }
