import { supabase } from './supabaseClient.js?v=8'
import {
  buildEmptyModel,
  fetchAllRows,
  findPeak,
  formatAht,
  formatCount,
  formatDate,
  formatPercentage,
  getLatestDate,
  numberOrNull,
  sumRows,
  titleFromKey
} from './data-details-utils.js?v=1'

export async function loadAgentDetail(agentKey) {
  const latestDate = await getLatestDate(
    'agent_productivity',
    [['agent_key', agentKey]]
  )

  if (!latestDate) {
    return buildEmptyModel(
      'Agent Productivity',
      titleFromKey(agentKey),
      'No synchronized productivity records were found for this agent.'
    )
  }

  const [latestTeamRows, historyRows, teamHistoryRows] = await Promise.all([
    fetchAllRows(() => supabase
      .from('agent_productivity')
      .select(
        'report_date, agent_key, agent_name, solved_tickets, open_tickets, aht_value, aht_unit'
      )
      .eq('report_date', latestDate)
      .order('agent_key', { ascending: true })),
    fetchAllRows(() => supabase
      .from('agent_productivity')
      .select(
        'report_date, agent_key, agent_name, solved_tickets, open_tickets, aht_value, aht_unit'
      )
      .eq('agent_key', agentKey)
      .order('report_date', { ascending: true })),
    fetchAllRows(() => supabase
      .from('agent_productivity')
      .select('report_date, agent_key, solved_tickets')
      .order('report_date', { ascending: true })
      .order('agent_key', { ascending: true }))
  ])

  const latestAgent = latestTeamRows.find(row => row.agent_key === agentKey) ||
    historyRows[historyRows.length - 1]
  const agentName = latestAgent?.agent_name ||
    historyRows[0]?.agent_name ||
    titleFromKey(agentKey)
  const teamSolvedLatest = sumRows(latestTeamRows, 'solved_tickets')
  const latestSolved = numberOrNull(latestAgent?.solved_tickets) || 0
  const teamTotalsByDate = new Map()

  teamHistoryRows.forEach(row => {
    const value = numberOrNull(row.solved_tickets)
    if (!row.report_date || value === null) return
    teamTotalsByDate.set(
      row.report_date,
      (teamTotalsByDate.get(row.report_date) || 0) + value
    )
  })

  const trendRows = historyRows.map(row => ({
    date: row.report_date,
    solved: numberOrNull(row.solved_tickets),
    open: numberOrNull(row.open_tickets)
  }))
  const peak = findPeak(trendRows, 'solved')
  const tableRows = [...historyRows]
    .sort((first, second) =>
      second.report_date.localeCompare(first.report_date)
    )
    .map(row => {
      const solved = numberOrNull(row.solved_tickets) || 0
      const teamTotal = teamTotalsByDate.get(row.report_date) || 0

      return [
        formatDate(row.report_date),
        formatCount(row.solved_tickets),
        formatCount(row.open_tickets),
        formatAht(row.aht_value),
        formatPercentage(teamTotal > 0 ? solved / teamTotal : 0)
      ]
    })

  return {
    eyebrow: 'Agent productivity detail',
    title: agentName,
    subtitle: 'Solved output, open workload, AHT, and team contribution over time.',
    latestDate,
    summaryCards: [
      {
        label: 'Solved tickets',
        value: formatCount(latestAgent?.solved_tickets),
        help: `Latest result for ${formatDate(latestDate)}`
      },
      {
        label: 'Open tickets',
        value: formatCount(latestAgent?.open_tickets),
        help: 'Latest reported open workload'
      },
      {
        label: 'AHT',
        value: formatAht(latestAgent?.aht_value),
        help: 'Displayed in minutes:seconds'
      },
      {
        label: 'Share of team output',
        value: formatPercentage(
          teamSolvedLatest > 0 ? latestSolved / teamSolvedLatest : 0
        ),
        help: `${formatCount(teamSolvedLatest)} tickets solved by the team`
      },
      {
        label: 'Highest solved day',
        value: peak ? formatDate(peak.date) : '—',
        help: peak ? `${formatCount(peak.value)} solved tickets` : 'No historical volume'
      }
    ],
    trendTitle: `${agentName} daily productivity`,
    trendSubtitle: 'Daily solved tickets and reported open-ticket workload.',
    trendRows,
    trendSeries: [
      { key: 'solved', label: 'Solved', tone: 'primary' },
      { key: 'open', label: 'Open', tone: 'secondary' }
    ],
    secondary: null,
    tableTitle: 'Agent productivity history',
    tableSubtitle: 'Daily productivity records with AHT and share of total team output.',
    tableColumns: [
      { label: 'Date' },
      { label: 'Solved', numeric: true },
      { label: 'Open', numeric: true },
      { label: 'AHT', numeric: true },
      { label: 'Team Share', numeric: true }
    ],
    tableRows
  }
}
