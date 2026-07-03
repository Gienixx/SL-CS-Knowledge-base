import { supabase } from './supabaseClient.js?v=8'
import { requiresFirstLoginPasswordChange } from './first-login-policy.js?v=4'

export const REPORT_TIME_ZONE = 'America/New_York'
export const DIMENSION_KEYS = Object.freeze([
  'app',
  'platform',
  'country',
  'concern',
  'priority',
  'channel'
])

export function normalize(value) {
  return String(value || '').trim().toLowerCase()
}

export function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) &&
    !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())
}

export function addDays(value, amount) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

export function daysInclusive(range) {
  const start = new Date(`${range.startDate}T12:00:00Z`)
  const end = new Date(`${range.endDate}T12:00:00Z`)
  return Math.round((end - start) / 86400000) + 1
}

export function previousRange(range) {
  const days = daysInclusive(range)
  return {
    startDate: addDays(range.startDate, -days),
    endDate: addDays(range.startDate, -1)
  }
}

export function formatDate(value, short = false) {
  if (!value) return 'No date'
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: short ? 'short' : 'long',
    day: 'numeric',
    year: short ? undefined : 'numeric'
  }).format(date)
}

export function rangeLabel(range) {
  return range.startDate === range.endDate
    ? formatDate(range.startDate)
    : `${formatDate(range.startDate, true)} – ${formatDate(range.endDate)}`
}

export function formatCount(value, fallback = 'Unavailable') {
  const number = Number(value)
  return Number.isFinite(number)
    ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(number)
    : fallback
}

export function formatPercent(value, { ratio = false, fallback = 'Unavailable' } = {}) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const percent = ratio ? number * 100 : number
  return `${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1
  }).format(percent)}%`
}

export function formatMinutes(value, fallback = 'Unavailable') {
  const minutes = Number(value)
  if (!Number.isFinite(minutes)) return fallback
  if (minutes < 60) return `${formatCount(minutes)} min`
  const hours = minutes / 60
  if (hours < 24) return `${formatCount(hours)} hr`
  return `${formatCount(hours / 24)} days`
}

export function formatAht(value, fallback = 'Unavailable') {
  const minutes = Number(value)
  if (!Number.isFinite(minutes)) return fallback
  const seconds = Math.round(minutes * 60)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function comparison(current, previous) {
  const currentNumber = Number(current)
  const previousNumber = Number(previous)
  if (!Number.isFinite(currentNumber) || !Number.isFinite(previousNumber)) {
    return { absolute: null, percentage: null }
  }
  const absolute = currentNumber - previousNumber
  const percentage = previousNumber === 0
    ? (currentNumber === 0 ? 0 : null)
    : (absolute / Math.abs(previousNumber)) * 100
  return { absolute, percentage }
}

export function parseRange(params, defaultRange = '30d') {
  const allowed = new Set(['latest', '7d', '30d', '90d', 'mtd', 'custom'])
  return {
    range: allowed.has(params.get('range')) ? params.get('range') : defaultRange,
    start: isIsoDate(params.get('start')) ? params.get('start') : '',
    end: isIsoDate(params.get('end')) ? params.get('end') : ''
  }
}

export function resolveRange(state, anchorDate) {
  if (!anchorDate) throw new Error('No synchronized Google Sheet reporting date is available.')
  if (state.range === 'custom') {
    if (!isIsoDate(state.start) || !isIsoDate(state.end)) {
      throw new Error('Choose both a valid start date and end date.')
    }
    if (state.start > state.end) throw new Error('The start date cannot be after the end date.')
    return { startDate: state.start, endDate: state.end }
  }
  if (state.range === 'latest') return { startDate: anchorDate, endDate: anchorDate }
  if (state.range === 'mtd') return { startDate: `${anchorDate.slice(0, 7)}-01`, endDate: anchorDate }
  const days = Number.parseInt(state.range, 10) || 30
  return { startDate: addDays(anchorDate, -(days - 1)), endDate: anchorDate }
}

export async function requireApprovedUser() {
  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError) throw userError
  if (!user) {
    window.location.replace('./login.html')
    return null
  }

  let currentUser = user
  if (requiresFirstLoginPasswordChange(currentUser)) {
    const { data: { session }, error } = await supabase.auth.refreshSession()
    if (!error && session?.user) currentUser = session.user
    if (requiresFirstLoginPasswordChange(currentUser)) {
      window.location.replace('./change-password.html?firstLogin=1')
      return null
    }
  }

  const email = currentUser.email?.trim().toLowerCase()
  if (!email) return null
  const { data, error } = await supabase
    .from('login')
    .select('email')
    .ilike('email', email)
    .limit(1)
  if (error) throw error
  if (!Array.isArray(data) || data.length === 0) {
    await supabase.auth.signOut()
    window.location.replace('./login.html')
    return null
  }
  return currentUser
}

export async function logout() {
  await supabase.auth.signOut()
  window.location.href = './login.html'
}

export async function latestDate(table, extra = null) {
  let query = supabase
    .from(table)
    .select('report_date')
    .order('report_date', { ascending: false })
    .limit(1)
  if (extra?.column && extra.value) query = query.eq(extra.column, extra.value)
  const { data, error } = await query
  if (error) throw error
  return data?.[0]?.report_date || null
}

export async function rowsForRange(table, columns, range, apply = null) {
  let query = supabase
    .from(table)
    .select(columns)
    .gte('report_date', range.startDate)
    .lte('report_date', range.endDate)
  if (apply) query = apply(query)
  const { data, error } = await query.order('report_date', { ascending: true })
  if (error) throw error
  return Array.isArray(data) ? data : []
}

function dedupeOptions(rows) {
  const map = new Map()
  rows.forEach(row => {
    const key = normalize(row.key)
    if (!key) return
    map.set(key, { key, label: row.label || key })
  })
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label))
}

export async function loadFilterOptions(range) {
  const [distributions, concerns, agents, agentDimensions] = await Promise.all([
    rowsForRange(
      'daily_distribution_metrics',
      'dimension_type, dimension_key, dimension_label',
      range
    ),
    rowsForRange(
      'ticket_driver_metrics',
      'driver_key, driver_label',
      range
    ),
    rowsForRange('agent_productivity', 'agent_key, agent_name', range),
    rowsForRange(
      'agent_dimension_metrics',
      'agent_key, agent_name, dimension_type, dimension_key, dimension_label',
      range
    )
  ])

  const aggregate = Object.fromEntries(DIMENSION_KEYS.map(key => [key, []]))
  const cross = Object.fromEntries(DIMENSION_KEYS.map(key => [key, []]))

  for (const type of ['app', 'platform', 'country']) {
    aggregate[type] = dedupeOptions(
      distributions
        .filter(row => row.dimension_type === type)
        .map(row => ({ key: row.dimension_key, label: row.dimension_label }))
    )
  }
  aggregate.concern = dedupeOptions(concerns.map(row => ({
    key: row.driver_key,
    label: row.driver_label
  })))

  for (const type of DIMENSION_KEYS) {
    cross[type] = dedupeOptions(
      agentDimensions
        .filter(row => row.dimension_type === type)
        .map(row => ({ key: row.dimension_key, label: row.dimension_label }))
    )
  }

  const options = Object.fromEntries(DIMENSION_KEYS.map(key => [
    key,
    dedupeOptions([...aggregate[key], ...cross[key]])
  ]))
  options.agent = dedupeOptions([
    ...agents.map(row => ({ key: row.agent_key, label: row.agent_name })),
    ...agentDimensions.map(row => ({ key: row.agent_key, label: row.agent_name }))
  ])
  options.aggregate = aggregate
  options.cross = cross
  return options
}

export function selectedDimension(state) {
  const active = DIMENSION_KEYS
    .map(key => ({ key, value: normalize(state[key]) }))
    .filter(row => row.value)
  if (active.length > 1) {
    throw new Error('Choose only one App, Platform, Country, Concern, Priority, or Channel filter at a time. The synchronized workbook does not contain ticket-level intersections.')
  }
  return active[0] || null
}

export async function loadAgentDimensionRows(range, dimension, agentKey = '') {
  if (!dimension) return []
  return rowsForRange(
    'agent_dimension_metrics',
    'report_date, agent_key, agent_name, dimension_type, dimension_key, dimension_label, ticket_count',
    range,
    query => {
      let next = query
        .eq('dimension_type', dimension.key)
        .eq('dimension_key', dimension.value)
      if (agentKey) next = next.eq('agent_key', agentKey)
      return next
    }
  )
}

export async function loadAllAgentDimensions(range, agentKey = '') {
  return rowsForRange(
    'agent_dimension_metrics',
    'report_date, agent_key, agent_name, dimension_type, dimension_key, dimension_label, ticket_count',
    range,
    query => agentKey ? query.eq('agent_key', agentKey) : query
  )
}

export async function loadTargets(metricKeys = []) {
  if (!metricKeys.length) return new Map()
  const { data, error } = await supabase
    .from('dashboard_targets')
    .select('metric_key, label, target_value, comparison_operator, unit')
    .in('metric_key', metricKeys)
    .eq('active', true)
  if (error) {
    if (error.code === '42P01') return new Map()
    throw error
  }
  return new Map((data || []).map(row => [row.metric_key, row]))
}

export function targetStatus(value, target) {
  const current = Number(value)
  const goal = Number(target?.target_value)
  if (!Number.isFinite(current) || !Number.isFinite(goal)) return null
  const operator = target.comparison_operator || 'at_least'
  const met = operator === 'at_most' ? current <= goal : current >= goal
  return { met, delta: current - goal, goal }
}

export { supabase }
