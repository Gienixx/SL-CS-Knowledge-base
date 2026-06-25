import { supabase } from './supabaseClient.js?v=8'

export const PAGE_SIZE = 1000
export const DEFAULT_DATE_RANGE = '30d'
export const DATE_RANGE_MODES = new Set([
  'latest',
  '7d',
  '30d',
  'mtd',
  'custom'
])

export function normalizeKey(value) {
  const key = typeof value === 'string'
    ? value.trim().toLowerCase()
    : ''

  return /^[a-z0-9_-]{1,80}$/.test(key) ? key : ''
}

export function normalizeDateRangeMode(value) {
  const mode = typeof value === 'string'
    ? value.trim().toLowerCase()
    : ''

  return DATE_RANGE_MODES.has(mode) ? mode : DEFAULT_DATE_RANGE
}

export function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }

  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function firstDayOfMonth(value) {
  return `${value.slice(0, 7)}-01`
}

export function parseDateRangeRequest(params) {
  const requestedMode = params.get('range')
  const hasCustomDates = params.has('start') || params.has('end')
  const mode = hasCustomDates && !requestedMode
    ? 'custom'
    : normalizeDateRangeMode(requestedMode)

  return {
    mode,
    start: params.get('start') || '',
    end: params.get('end') || ''
  }
}

export function resolveDateRange(latestAvailableDate, request) {
  if (!latestAvailableDate || !isIsoDate(latestAvailableDate)) {
    return {
      mode: request?.mode || DEFAULT_DATE_RANGE,
      start: null,
      end: null,
      label: 'No available dates'
    }
  }

  const mode = normalizeDateRangeMode(request?.mode)

  if (mode === 'custom') {
    const start = request?.start || ''
    const end = request?.end || ''

    if (!isIsoDate(start) || !isIsoDate(end)) {
      throw new Error('Choose a valid custom start date and end date.')
    }

    if (start > end) {
      throw new Error('The custom start date cannot be after the end date.')
    }

    return {
      mode,
      start,
      end,
      label: `${formatDate(start)} – ${formatDate(end)}`
    }
  }

  if (mode === 'latest') {
    return {
      mode,
      start: latestAvailableDate,
      end: latestAvailableDate,
      label: `Latest date: ${formatDate(latestAvailableDate)}`
    }
  }

  const start = mode === '7d'
    ? shiftDate(latestAvailableDate, -6)
    : mode === 'mtd'
      ? firstDayOfMonth(latestAvailableDate)
      : shiftDate(latestAvailableDate, -29)

  return {
    mode,
    start,
    end: latestAvailableDate,
    label: `${formatDate(start)} – ${formatDate(latestAvailableDate)}`
  }
}

export function applyDateRange(query, dateRange) {
  if (!dateRange?.start || !dateRange?.end) return query

  return query
    .gte('report_date', dateRange.start)
    .lte('report_date', dateRange.end)
}

export function numberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function formatCount(value) {
  const number = numberOrNull(value)
  return number === null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        maximumFractionDigits: 0
      }).format(number)
}

export function formatPercentage(value) {
  const number = numberOrNull(value)
  return number === null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'percent',
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      }).format(number)
}

export function formatAht(value) {
  const decimalMinutes = numberOrNull(value)
  if (decimalMinutes === null || decimalMinutes < 0) return '—'

  const totalSeconds = Math.round(decimalMinutes * 60)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function formatDate(value) {
  if (!value) return 'No data'
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return String(value)

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date)
}

export function formatShortDate(value) {
  if (!value) return ''
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return String(value)

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric'
  }).format(date)
}

export function sumRows(rows, field) {
  return rows.reduce((sum, row) => {
    const value = numberOrNull(row[field])
    return value === null ? sum : sum + value
  }, 0)
}

export function titleFromKey(key) {
  return key
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export async function fetchAllRows(queryFactory) {
  const rows = []
  let start = 0

  while (true) {
    const { data, error } = await queryFactory()
      .range(start, start + PAGE_SIZE - 1)

    if (error) throw error

    const page = Array.isArray(data) ? data : []
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
    start += PAGE_SIZE
  }

  return rows
}

export async function getLatestDate(tableName, filters, dateRange = null) {
  let query = supabase.from(tableName).select('report_date')

  filters.forEach(([column, value]) => {
    query = query.eq(column, value)
  })

  query = applyDateRange(query, dateRange)

  const { data, error } = await query
    .order('report_date', { ascending: false })
    .limit(1)

  if (error) throw error
  return data?.[0]?.report_date || null
}

export function aggregateByDate(rows, field) {
  const totals = new Map()

  rows.forEach(row => {
    const date = row.report_date
    const value = numberOrNull(row[field])
    if (!date || value === null) return
    totals.set(date, (totals.get(date) || 0) + value)
  })

  return [...totals.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((first, second) => first.date.localeCompare(second.date))
}

export function findPeak(rows, field) {
  return rows.reduce((peak, row) => {
    const value = numberOrNull(row[field])
    if (value === null) return peak
    if (!peak || value > peak.value) {
      return { date: row.date || row.report_date, value }
    }
    return peak
  }, null)
}

export function buildEmptyModel(eyebrow, title, message, dateRange = null) {
  return {
    eyebrow,
    title,
    subtitle: message,
    latestDate: null,
    dateRange,
    summaryCards: [{
      label: 'Status',
      value: 'No data',
      help: 'The selected date range has no synchronized records.'
    }],
    trendTitle: 'Daily trend',
    trendSubtitle: message,
    trendRows: [],
    trendSeries: [{ key: 'tickets', label: 'Tickets', tone: 'primary' }],
    secondary: null,
    tableTitle: 'Detailed history',
    tableSubtitle: message,
    tableColumns: [{ label: 'Date' }],
    tableRows: []
  }
}
