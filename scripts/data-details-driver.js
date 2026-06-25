import { supabase } from './supabaseClient.js?v=8'
import {
  aggregateByDate,
  applyDateRange,
  buildEmptyModel,
  fetchAllRows,
  findPeak,
  formatCount,
  formatDate,
  formatPercentage,
  getLatestDate,
  resolveDateRange,
  sumRows,
  titleFromKey
} from './data-details-utils.js?v=2'

export async function loadDriverDetail(groupKey, rangeRequest) {
  const latestAvailableDate = await getLatestDate(
    'ticket_driver_metrics',
    [['driver_group_key', groupKey]]
  )

  if (!latestAvailableDate) {
    return buildEmptyModel(
      'Ticket Driver Group',
      titleFromKey(groupKey),
      'No synchronized records were found for this driver group.'
    )
  }

  const dateRange = resolveDateRange(latestAvailableDate, rangeRequest)
  const historyRows = await fetchAllRows(() => applyDateRange(
    supabase
      .from('ticket_driver_metrics')
      .select(
        'report_date, driver_group_key, driver_group_label, driver_key, driver_label, ticket_count'
      )
      .eq('driver_group_key', groupKey)
      .order('report_date', { ascending: true })
      .order('driver_key', { ascending: true }),
    dateRange
  ))

  if (historyRows.length === 0) {
    return buildEmptyModel(
      'Ticket Driver Group',
      titleFromKey(groupKey),
      `No ticket-driver records were found for ${dateRange.label}.`,
      dateRange
    )
  }

  const dailyTrend = aggregateByDate(historyRows, 'ticket_count')
  const latestDate = dailyTrend[dailyTrend.length - 1].date
  const [latestGroupRows, latestAllRows] = await Promise.all([
    fetchAllRows(() => supabase
      .from('ticket_driver_metrics')
      .select(
        'report_date, driver_group_key, driver_group_label, driver_key, driver_label, ticket_count'
      )
      .eq('report_date', latestDate)
      .eq('driver_group_key', groupKey)
      .order('driver_label', { ascending: true })),
    fetchAllRows(() => supabase
      .from('ticket_driver_metrics')
      .select('report_date, driver_key, ticket_count')
      .eq('report_date', latestDate)
      .order('driver_key', { ascending: true }))
  ])

  const groupLabel = latestGroupRows[0]?.driver_group_label ||
    historyRows[0]?.driver_group_label ||
    titleFromKey(groupKey)
  const latestGroupTotal = sumRows(latestGroupRows, 'ticket_count')
  const latestAllTotal = sumRows(latestAllRows, 'ticket_count')
  const peak = findPeak(dailyTrend, 'value')
  const latestConcerns = [...latestGroupRows].sort((first, second) =>
    (Number(second.ticket_count) || 0) -
      (Number(first.ticket_count) || 0) ||
    String(first.driver_label).localeCompare(String(second.driver_label))
  )
  const leadingConcern = latestConcerns.find(
    row => (Number(row.ticket_count) || 0) > 0
  )
  const groupTotalsByDate = new Map(
    dailyTrend.map(row => [row.date, row.value])
  )
  const tableRows = [...historyRows]
    .sort((first, second) =>
      second.report_date.localeCompare(first.report_date) ||
      (Number(second.ticket_count) || 0) -
        (Number(first.ticket_count) || 0) ||
      String(first.driver_label).localeCompare(String(second.driver_label))
    )
    .map(row => {
      const groupTotal = groupTotalsByDate.get(row.report_date) || 0
      const ticketCount = Number(row.ticket_count) || 0

      return [
        formatDate(row.report_date),
        row.driver_label || row.driver_key,
        formatCount(ticketCount),
        formatCount(groupTotal),
        formatPercentage(groupTotal > 0 ? ticketCount / groupTotal : 0)
      ]
    })

  return {
    eyebrow: 'Ticket driver detail',
    title: groupLabel,
    subtitle: 'Concern-level volume and historical activity for this ticket-driver group.',
    latestDate,
    dateRange,
    summaryCards: [
      {
        label: 'Group total',
        value: formatCount(latestGroupTotal),
        help: `Latest result in range: ${formatDate(latestDate)}`
      },
      {
        label: 'Share of all drivers',
        value: formatPercentage(
          latestAllTotal > 0 ? latestGroupTotal / latestAllTotal : 0
        ),
        help: `${formatCount(latestAllTotal)} mapped driver tickets on ${formatDate(latestDate)}`
      },
      {
        label: 'Highest-volume concern',
        value: leadingConcern?.driver_label || 'No volume',
        help: leadingConcern
          ? `${formatCount(leadingConcern.ticket_count)} tickets on ${formatDate(latestDate)}`
          : 'All latest concern values are zero'
      },
      {
        label: 'Highest-volume date',
        value: peak ? formatDate(peak.date) : '—',
        help: peak ? `${formatCount(peak.value)} tickets` : 'No volume in range'
      }
    ],
    trendTitle: `${groupLabel} daily trend`,
    trendSubtitle: `Daily ticket count for ${dateRange.label}.`,
    trendRows: dailyTrend.map(row => ({
      date: row.date,
      tickets: row.value
    })),
    trendSeries: [{ key: 'tickets', label: 'Tickets', tone: 'primary' }],
    secondary: {
      title: 'Individual concerns',
      subtitle: `Latest concern breakdown in range: ${formatDate(latestDate)}.`,
      rows: latestConcerns.map(row => {
        const ticketCount = Number(row.ticket_count) || 0
        return {
          label: row.driver_label || row.driver_key,
          value: ticketCount,
          share: latestGroupTotal > 0
            ? ticketCount / latestGroupTotal
            : 0
        }
      })
    },
    tableTitle: 'Driver detail history',
    tableSubtitle: `Concern-level records for ${dateRange.label}.`,
    tableColumns: [
      { label: 'Date' },
      { label: 'Concern' },
      { label: 'Ticket Count', numeric: true },
      { label: 'Group Total', numeric: true },
      { label: 'Share of Group', numeric: true }
    ],
    tableRows
  }
}
