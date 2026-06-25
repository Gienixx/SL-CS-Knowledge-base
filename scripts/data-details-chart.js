import {
  formatCount,
  formatDate,
  formatShortDate,
  numberOrNull
} from './data-details-utils.js?v=1'

export function renderTrendChart(container, titleElement, rows, series) {
  container.replaceChildren()

  if (!Array.isArray(rows) || rows.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'detail-empty'
    empty.textContent = 'No historical data is available for this selection.'
    container.appendChild(empty)
    return
  }

  const maximum = Math.max(
    1,
    ...rows.flatMap(row => series.map(item =>
      Math.max(0, numberOrNull(row[item.key]) || 0)
    ))
  )
  const chart = document.createElement('div')
  chart.className = 'trend-history'
  chart.setAttribute('role', 'img')
  chart.setAttribute('aria-label', `${titleElement.textContent} historical chart`)

  rows.forEach(row => {
    const item = document.createElement('div')
    item.className = 'trend-history-row'

    const date = document.createElement('span')
    date.className = 'trend-history-date'
    date.textContent = formatShortDate(row.date)
    date.title = formatDate(row.date)

    const bars = document.createElement('div')
    bars.className = 'trend-history-bars'

    series.forEach(seriesItem => {
      const value = numberOrNull(row[seriesItem.key])
      const line = document.createElement('div')
      line.className = 'trend-history-series'

      const label = document.createElement('span')
      label.textContent = seriesItem.label

      const track = document.createElement('div')
      track.className = 'trend-track'
      const bar = document.createElement('span')
      bar.className = `trend-bar${seriesItem.tone === 'secondary' ? ' secondary' : ''}`
      bar.style.width = `${value === null ? 0 : Math.max(0, value / maximum * 100)}%`
      track.appendChild(bar)

      const amount = document.createElement('span')
      amount.className = 'trend-history-value'
      amount.textContent = formatCount(value)

      line.append(label, track, amount)
      bars.appendChild(line)
    })

    item.append(date, bars)
    chart.appendChild(item)
  })

  container.appendChild(chart)
}
