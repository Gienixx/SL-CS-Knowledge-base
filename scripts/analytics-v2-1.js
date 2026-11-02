import { supabase } from './supabaseClient.js?v=11'
import { metrics, filterSnapshot } from './analytics-v2-1-model.js'

const $ = id => document.getElementById(id)
const names = ['Arby', 'Gen', 'Arez', 'Tommy Fang']
const format = value => value.toLocaleString('en-US')
let snapshot, model, committed = [...names]

function node(tag, text, className) {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = text
  if (className) element.className = className
  return element
}

function selected() { return [...document.querySelectorAll('#agent-options input:checked')].map(input => input.value) }
function selectionLabel() { $('agent-summary').textContent = `${selected().length} selected` }
function setSelection(values) {
  document.querySelectorAll('#agent-options input').forEach(input => { input.checked = values.includes(input.value) })
  selectionLabel()
}

for (const name of names) {
  const label = node('label', undefined, 'agent-option')
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'; checkbox.value = name; checkbox.checked = true
  checkbox.addEventListener('change', selectionLabel)
  label.append(checkbox, node('span', name)); $('agent-options').append(label)
}

function message(text) {
  $('message').textContent = text
  $('results').hidden = true
  $('download').disabled = true
  model = null
}

function render() {
  if (!snapshot) return
  const start = $('start').value, end = $('end').value, agents = selected()
  $('agent-picker').open = false
  if (start > end) return message('Choose an end date on or after the start date.')
  if (!agents.length) return message('Select at least one agent to view the report.')
  committed = agents
  model = filterSnapshot(snapshot, { start, end, agents })
  if (!model) return message('Data unavailable for this range. This saved verification covers October 30, 2026 only. Reset filters to view it.')
  $('message').textContent = ''
  $('results').hidden = false
  $('download').disabled = false
  $('range-caption').textContent = `October 30, 2026 · ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`
  $('kpis').replaceChildren()
  for (const key of ['updates', 'public', 'internal', 'commented', 'solved', 'created']) {
    const label = key === 'commented' ? 'Tickets commented' : metrics.find(([metric]) => metric === key)[1]
    const card = node('article', undefined, 'kpi')
    card.append(node('span', label, 'kpi-label'), node('strong', format(model.total[key])), node('span', 'Selected agents', 'kpi-context'))
    $('kpis').append(card)
  }
  $('agent-rows').replaceChildren()
  for (const row of model.rows) {
    const tr = document.createElement('tr'), th = node('th')
    th.scope = 'row'
    th.append(node('span', row.agent.split(' ').map(word => word[0]).join(''), 'avatar'), node('span', row.agent))
    tr.append(th)
    metrics.forEach(([key]) => tr.append(node('td', format(row[key]), row[key] === 0 ? 'zero' : '')))
    $('agent-rows').append(tr)
  }
  const totalRow = document.createElement('tr'), totalHeading = node('th', 'Total')
  totalHeading.scope = 'row'; totalRow.append(totalHeading)
  metrics.forEach(([key]) => totalRow.append(node('td', format(model.total[key]))))
  $('totals').replaceChildren(totalRow)
  $('comment-chart').replaceChildren()
  const max = Math.max(...model.rows.map(row => row.comments), 1)
  for (const row of model.rows) {
    const item = node('div', undefined, 'chart-row'), top = node('div', undefined, 'chart-label')
    top.append(node('span', row.agent), node('strong', format(row.comments)))
    const track = node('div', undefined, 'bar-track')
    track.setAttribute('role', 'img')
    track.setAttribute('aria-label', `${row.agent}: ${row.public} public comments and ${row.internal} internal notes`)
    for (const key of ['public', 'internal']) {
      const bar = node('span', undefined, `bar-${key}`)
      bar.style.width = `${row[key] / max * 100}%`; track.append(bar)
    }
    item.append(top, track); $('comment-chart').append(item)
  }
  $('coverage').textContent = `Completed event stream through ${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: snapshot.timezone }).format(new Date(snapshot.streamThrough))} (New York). Saved results, not a live feed.`
}

$('filters').addEventListener('submit', event => { event.preventDefault(); render() })
$('select-all').addEventListener('click', () => setSelection(names))
$('clear-all').addEventListener('click', () => setSelection([]))
$('cancel-agents').addEventListener('click', () => { setSelection(committed); $('agent-picker').open = false })
$('reset').addEventListener('click', () => {
  $('start').value = $('end').value = '2026-10-30'
  $('agent-search').value = ''; document.querySelectorAll('.agent-option').forEach(label => { label.hidden = false })
  $('no-matches').hidden = true; setSelection(names); render()
})
$('agent-search').addEventListener('input', event => {
  let matches = 0
  document.querySelectorAll('.agent-option').forEach(label => {
    label.hidden = !label.textContent.toLowerCase().includes(event.target.value.trim().toLowerCase())
    if (!label.hidden) matches++
  })
  $('no-matches').hidden = matches !== 0
})
$('agent-picker').addEventListener('keydown', event => {
  if (event.key === 'Escape') { setSelection(committed); $('agent-picker').open = false; $('agent-picker').querySelector('summary').focus() }
})
$('download').addEventListener('click', () => {
  if (!model) return
  const lines = [['Updater name', ...metrics.map(([, label]) => label)], ...model.rows.map(row => [row.agent, ...metrics.map(([key]) => row[key])]), ['Total', ...metrics.map(([key]) => model.total[key])]]
  const metadata = [['Source', snapshot.classification], ['Date', snapshot.date], ['Timezone', snapshot.timezone], ['Group', snapshot.group], ['State', 'Saved verification; Explore parity not verified'], []]
  const csv = [...metadata, ...lines].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), link = document.createElement('a')
  link.href = url; link.download = 'analytics.v2-1-2026-10-30.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
})

async function load() {
  try {
    const { data, error } = await supabase.auth.getSession()
    if (error) throw error
    if (!data.session?.access_token) {
      const url = new URL('./login.html', location.href)
      url.searchParams.set('returnTo', location.pathname)
      location.replace(url.href); return
    }
    const response = await fetch('./api/analytics-v2-1', { headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: 'no-store' })
    if (response.status === 401) return message('Your session has expired. Sign in again from Home to view this report.')
    if (response.status === 403) return message('This preview requires workforce report access. Contact your administrator.')
    if (!response.ok) throw new Error('Report unavailable')
    snapshot = await response.json(); render()
  } catch {
    message('The preview could not load. Try reloading the page. A site session and the preview API are required.')
  }
}
load()
