import { supabase } from './supabaseClient.js?v=11'
import { loadCurrentWorkforceAccess } from './workforce-permissions.js?v=1'

const PAGE_SIZE = 50
let page = 0
const el = id => document.getElementById(id)
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
const dateText = value => new Intl.DateTimeFormat(undefined, { dateStyle:'medium', timeStyle:'short' }).format(new Date(value))
const statusClass = value => value === 'Completed' ? 'success' : 'warning'
const possessive = name => `${name || 'This user'}'${String(name || '').toLowerCase().endsWith('s') ? '' : 's'}`
const FIELD_LABELS = {
  clock_in: 'Clock-in',
  clock_out: 'Clock-out',
  clock_in_at: 'Clock-in',
  clock_out_at: 'Clock-out',
  billed_clock_in: 'Billed Clock-in',
  billed_clock_out: 'Billed Clock-out',
  billed_clock_in_at: 'Billed Clock-in',
  billed_clock_out_at: 'Billed Clock-out',
  shift_start: 'Shift start',
  shift_end: 'Shift end',
  review_status: 'Review status',
  base_role: 'Role',
  status: 'Status'
}
const formatReason = value => String(value || '').replaceAll('_', ' ')
function formatDisplayValue(value, field) {
  if (value === null || value === undefined || value === '') return ''
  if (field.includes('clock') || field.includes('shift_')) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(parsed)
    }
  }
  if (typeof value === 'boolean') return value ? 'enabled' : 'disabled'
  return String(value).replaceAll('_', ' ')
}
function statement(row) {
  const actor = row.done_by || 'An admin'
  const target = row.affected_user || 'this employee'
  const action = String(row.details?.action || row.action_label || '').toLowerCase()
  const before = row.details?.before || {}
  const after = row.details?.after || {}
  let text = `${actor} completed ${String(row.action_label || 'a system action').toLowerCase()}.`
  if (action.includes('admin_assist') && action.includes('clock_in')) text = `${actor} assisted ${target} with clock-in.`
  else if (action.includes('admin_assist') && action.includes('clock_out')) text = `${actor} assisted ${target} with clock-out.`
  else if (action.includes('attendance_deleted')) text = `${actor} deleted an attendance record for ${target}.`
  else if (action.includes('attendance_billed_time_corrected')) text = `${possessive(target)} billed attendance was corrected by ${actor}.`
  else if (action.includes('attendance_correct')) text = `${possessive(target)} attendance was corrected by ${actor}.`
  else if (action.includes('payroll_recalculated')) text = row.details?.after?.period_label
    ? `Payroll period ${row.details.after.period_label} was recalculated.`
    : `${possessive(target)} payroll was recalculated by ${actor}.`
  else if (action.includes('payroll_approved')) text = `${possessive(target)} payroll was approved by ${actor}.`
  else if (action.includes('prepaid') && action.includes('applied')) text = `${possessive(target)} prepaid hours were applied to approved attendance.`
  else if (action.includes('leave') && action.includes('approved')) text = `${possessive(target)} leave request was approved by ${actor}.`
  else if (action.includes('leave') && action.includes('reject')) text = `${possessive(target)} leave request was rejected by ${actor}.`
  else if (action.includes('schedule') || row.category === 'Schedules') text = `${actor} updated ${possessive(target)} schedule.`
  else if (action.includes('permission') || row.category === 'Users & Access') text = `${possessive(target)} access was updated by ${actor}.`
  const changes = []
  const fields = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const field of fields) {
    if (!FIELD_LABELS[field]) continue
    if (before[field] !== undefined || after[field] !== undefined) {
      const label = FIELD_LABELS[field]
      const oldValue = formatDisplayValue(before[field], field)
      const newValue = formatDisplayValue(after[field], field)
      if (oldValue === newValue) continue
      if (!oldValue && newValue) changes.push(`${label} was set to ${newValue}.`)
      else if (oldValue && newValue) changes.push(`${label} was changed from ${oldValue} to ${newValue}.`)
      else if (oldValue && !newValue) changes.push(`${label} was cleared.`)
    }
  }
  if (changes.length) {
    const attendanceChange = changes.some(change => /clock-in|clock-out/i.test(change))
    text = attendanceChange
      ? `${actor} updated ${target === 'this employee' ? 'this employee' : possessive(target)} attendance. ${changes.join(' ')}`
      : `${text.replace(/\.$/, '')}. ${changes.join(' ')}`
  }
  if (row.details?.reason) text += ` Reason: ${formatReason(row.details.reason)}.`
  return text
}
function normalizeRow(row) {
  const normalized = { ...row }
  // The main table has one explicit display contract. Never bind it to the
  // raw details/metadata/payload fields returned for troubleshooting.
  normalized.display_details = statement({
    ...row,
    details: row.technical_details || row.details || {}
  }) || fallbackDetails(row.category)
  return normalized
}

function fallbackDetails(category) {
  if (category === 'Attendance') return 'Attendance activity was recorded.'
  if (category === 'Payroll') return 'Payroll activity was recorded.'
  if (category === 'Users & Access') return 'User access activity was recorded.'
  return 'System activity was recorded.'
}

async function loadActivity() {
  const access = await loadCurrentWorkforceAccess(supabase, { allowLegacyFallback: false })
  if (!access.is_admin) { window.location.replace('./home.html'); return }
  const { data, error } = await supabase.rpc('activity_log_list', {
    p_category: el('activityCategory').value || null,
    p_date_from: el('activityFrom').value || null,
    p_date_to: el('activityTo').value || null,
    p_search: el('activitySearch').value.trim() || null,
    p_status: el('activityStatus').value || null,
    p_limit: PAGE_SIZE,
    p_offset: page * PAGE_SIZE
  })
  if (error) throw error
  const rows = (data || []).map(normalizeRow)
  el('activityBody').innerHTML = rows.length ? rows.map(row => `<tr><td>${escapeHtml(dateText(row.occurred_at))}</td><td><span class="wf-badge">${escapeHtml(row.category)}</span></td><td><strong>${escapeHtml(row.action_label)}</strong></td><td>${escapeHtml(row.done_by || 'System')}</td><td>${escapeHtml(row.affected_user || '—')}</td><td>${escapeHtml(row.display_details || row.summary || 'Activity recorded')}</td><td><span class="wf-badge ${statusClass(row.status)}">${escapeHtml(row.status)}</span></td><td><details><summary>Technical details</summary><pre>${escapeHtml(JSON.stringify(row.technical_details || {}, null, 2))}</pre></details></td></tr>`).join('') : '<tr><td colspan="8" class="wf-empty">No activity matches these filters.</td></tr>'
  el('activityPageStatus').textContent = `Page ${page + 1}`
  el('activityPrevious').disabled = page === 0
  el('activityNext').disabled = rows.length < PAGE_SIZE
  el('activityMessage').textContent = rows.length ? `${rows.length} activities shown.` : 'No activity found.'
}
async function refresh(reset = true) { if (reset) page = 0; try { await loadActivity() } catch (error) { el('activityMessage').textContent = 'Unable to load the Activity Log.'; el('activityMessage').classList.add('error'); console.error(error) } }
['activitySearch','activityCategory','activityStatus','activityFrom','activityTo'].forEach(id => el(id).addEventListener(id === 'activitySearch' ? 'input' : 'change', () => refresh()))
el('activityPrevious').addEventListener('click', () => { if (page) { page -= 1; refresh(false) } })
el('activityNext').addEventListener('click', () => { page += 1; refresh(false) })
refresh()
