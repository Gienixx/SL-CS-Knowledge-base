import { supabase } from './supabaseClient.js?v=8'
import {
  buildEmptyModel,
  fetchAllRows,
  findPeak,
  formatCount,
  formatDate,
  formatPercentage,
  getLatestDate,
  numberOrNull,
  sumRows,
  titleFromKey
} from './data-details-utils.js?v=1'

export async function loadDistributionDetail(view, dimensionKey) {
  const latestDate = await getLatestDate(
    'daily_distribution_metrics',
    [
      ['dimension_type', view],
      ['dimension_key', dimensionKey]
    ]
  )

  if (!latestDate) {
    return buildEmptyModel(
      `${titleFromKey(view)} Distribution`,
      titleFromKey(dimensionKey),
      `No synchronized ${view} records were found for this selection.`
    )
  }

  const [latestDimensionRows, historyRows, dimensionHistoryRows] =
    await Promise.all([
      fetchAllRows(() => supabase
        .from('daily_distribution_metrics')
        .select(
          'report_date, dimension_type, dimension_key, dimension_label, ticket_count'
        )
        .eq('report_date', latestDate)
        .eq('dimension_type', view)
        .order('dimension_key', { ascending: true })),
      fetchAllRows(() => supabase
        .from('daily_distribution_metrics')
        .select(
          'report_date, dimension_type, dimension_key, dimension_label, ticket_count'
        )
        .eq('dimension_type', view)
        .eq('dimension_key', dimensionKey)
        .order('report_date', { ascending: true })),
      fetchAllRows(() => supabase
        .from('daily_distribution_metrics')
        .select('report_date, dimension_type, dimension_key, ticket_count')
        .eq('dimension_type', view)
        .order('report_date', { ascending: true })
        .order('dimension_key', { ascending: true }))
    ])

  const latestSelected = latestDimensionRows.find(
    row => row.dimension_key === dimensionKey
  ) || historyRows[historyRows.length - 1]
  const selectedLabel = latestSelected?.dimension_label ||
    historyRows[0]?.dimension_label ||
    titleFromKey(dimensionKey)
  const latestDimensionTotal = sumRows(latestDimensionRows, 'ticket_count')
  const latestCount = numberOrNull(latestSelected?.ticket_count) || 0
  const totalsByDate = new Map()

  dimensionHistoryRows.forEach(row => {
    const value = numberOrNull(row.ticket_count)
    if (!row.report_date || value === null) return
    totalsByDate.set(
      row.report_date,
      (totalsByDate.get(row.report_date) || 0) + value
    )
  })

  const trendRows = historyRows.map(row => ({
    date: row.report_date,
    tickets: numberOrNull(row.ticket_count)
  }))
  const peak = findPeak(trendRows, 'tickets')
  const tableRows = [...historyRows]
    .sort((first, second) =>
      second.report_date.localeCompare(first.report_date)
    )
    .map(row => {
      const ticketCount = numberOrNull(row.ticket_count) || 0
      const dimensionTotal = totalsByDate.get(row.report_date) || 0

      return [
        formatDate(row.report_date),
        formatCount(ticketCount),
        formatCount(dimensionTotal),
        formatPercentage(
          dimensionTotal > 0 ? ticketCount / dimensionTotal : 0
        )
      ]
    })

  const dimensionName = titleFromKey(view)

  return {
    eyebrow: `${dimensionName} distribution detail`,
    title: selectedLabel,
    subtitle: `Ticket volume and share within the ${view} distribution over time.`,
    latestDate,
    summaryCards: [
      {
        label: 'Ticket total',
        value: formatCount(latestCount),
        help: `Latest result for ${formatDate(latestDate)}`
      },
      {
        label: `Share of ${view} total`,
        value: formatPercentage(
          latestDimensionTotal > 0
            ? latestCount / latestDimensionTotal
            : 0
        ),
        help: `${formatCount(latestDimensionTotal)} mapped ${view} tickets`
      },
      {
        label: 'Highest-volume day',
        value: peak ? formatDate(peak.date) : '—',
        help: peak ? `${formatCount(peak.value)} tickets` : 'No historical volume'
      },
      {
        label: 'Days reported',
        value: formatCount(historyRows.length),
        help: 'Available synchronized reporting dates'
      }
    ],
    trendTitle: `${selectedLabel} daily trend`,
    trendSubtitle: `Daily ticket count for this ${view} selection.`,
    trendRows,
    trendSeries: [{ key: 'tickets', label: 'Tickets', tone: 'primary' }],
    secondary: null,
    tableTitle: `${dimensionName} distribution history`,
    tableSubtitle: `Daily count and share of the complete ${view} distribution.`,
    tableColumns: [
      { label: 'Date' },
      { label: 'Ticket Count', numeric: true },
      { label: `${dimensionName} Total`, numeric: true },
      { label: 'Percentage', numeric: true }
    ],
    tableRows
  }
}
