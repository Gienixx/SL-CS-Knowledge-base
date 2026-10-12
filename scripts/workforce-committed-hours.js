import { supabase } from './supabaseClient.js?v=11'
import { requireWorkforcePermission } from './workforce-permissions.js?v=1'

const elements = {
  tab: document.getElementById('committedHoursViewButton'),
  panel: document.getElementById('committedHoursManagementSection'),
  startDate: document.getElementById('committedHoursStartDate'),
  endDate: document.getElementById('committedHoursEndDate'),
  teamFilter: document.getElementById('committedHoursTeamFilter'),
  employeeFilter: document.getElementById('committedHoursEmployeeFilter'),
  tableBody: document.getElementById('committedHoursTableBody'),
  message: document.getElementById('committedHoursMessage'),
  refreshButton: document.getElementById('refreshCommittedHoursButton'),
  addButton: document.getElementById('addCommittedHoursButton'),
  modal: document.getElementById('committedHoursModal'),
  form: document.getElementById('committedHoursForm'),
  formMessage: document.getElementById('committedHoursFormMessage'),
  modalTitle: document.getElementById('committedHoursModalTitle'),
  commitmentId: document.getElementById('committedHoursCommitmentId'),
  employee: document.getElementById('committedHoursEmployee'),
  workDate: document.getElementById('committedHoursWorkDate'),
  targetHours: document.getElementById('committedHoursTargetHours'),
  reason: document.getElementById('committedHoursReason'),
  saveButton: document.getElementById('saveCommittedHoursButton')
}

let employees = []
let teams = []
let access = null
let previousFocus = null
let loading = false

function workforceToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date())
  const part = type => parts.find(value => value.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

function setMessage(element, value, type = '') {
  if (!element) return
  element.textContent = value
  element.className = type ? `wf-message ${type}` : 'wf-message'
}

function displayName(employee) {
  return employee.full_name?.trim() || employee.email || 'Unknown employee'
}

function formatMinutes(value) {
  const minutes = Math.max(0, Number(value) || 0)
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`
}

function formatDate(value) {
  if (!value) return '—'
  const [year, month, day] = value.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    .format(new Date(Date.UTC(year, month - 1, day, 12)))
}

function setLoading(isLoading) {
  loading = isLoading
  elements.refreshButton.disabled = isLoading
  elements.addButton.disabled = isLoading
  elements.saveButton.disabled = isLoading
}

function selectedEmployees() {
  const teamId = elements.teamFilter.value
  return employees.filter(employee => !teamId || employee.team_id === teamId)
}

function fillEmployeeSelect(select, placeholder) {
  const previousValue = select.value
  const options = [new Option(placeholder, '')]
  selectedEmployees().forEach(employee => options.push(new Option(displayName(employee), employee.user_id)))
  select.replaceChildren(...options)
  if (selectedEmployees().some(employee => employee.user_id === previousValue)) select.value = previousValue
}

function fillTeamFilter() {
  const options = [new Option('All teams', '')]
  teams.forEach(team => options.push(new Option(team.name, team.id)))
  elements.teamFilter.replaceChildren(...options)
}

function showModal(row = null) {
  previousFocus = document.activeElement
  elements.form.reset()
  elements.commitmentId.value = row?.commitment_id || ''
  elements.modalTitle.textContent = row ? 'Edit Commitment' : 'Add Commitment'
  elements.employee.value = row?.employee_user_id || ''
  elements.employee.disabled = Boolean(row)
  elements.workDate.value = row?.work_date || workforceToday()
  elements.targetHours.value = row ? (Number(row.target_minutes) / 60).toString() : '8'
  elements.reason.value = row?.reason || ''
  elements.formMessage.textContent = ''
  elements.modal.hidden = false
  document.body.classList.add('modal-open')
  elements.employee.focus()
}

function closeModal() {
  elements.modal.hidden = true
  document.body.classList.remove('modal-open')
  elements.employee.disabled = false
  previousFocus?.focus?.()
}

function appendCell(row, content, className = '') {
  const cell = document.createElement('td')
  if (content instanceof Node) cell.appendChild(content)
  else cell.textContent = content
  if (className) cell.className = className
  row.appendChild(cell)
}

function renderRows(rows) {
  const fragment = document.createDocumentFragment()
  if (!rows.length) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 8
    cell.className = 'wf-empty'
    cell.textContent = 'No Committed Hours targets match these filters. Employees without a target have no commitment required.'
    row.appendChild(cell)
    fragment.appendChild(row)
    elements.tableBody.replaceChildren(fragment)
    return
  }

  rows.forEach(item => {
    const row = document.createElement('tr')
    appendCell(row, item.employee_name || 'Unknown employee')
    appendCell(row, formatDate(item.work_date))
    appendCell(row, formatMinutes(item.target_minutes))
    appendCell(row, formatMinutes(item.fulfilled_minutes))
    appendCell(row, Number(item.carryover_minutes) > 0 ? formatMinutes(item.carryover_minutes) : '—')
    appendCell(row, formatMinutes(item.remaining_minutes))

    const badge = document.createElement('span')
    badge.className = `wf-badge ${item.status === 'Complete' ? 'success' : item.status === 'Outstanding' ? 'warning' : 'muted'}`
    badge.textContent = item.status || 'Outstanding'
    appendCell(row, badge)

    const actions = document.createElement('div')
    actions.className = 'wf-row-actions'
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'wf-row-btn'
    edit.textContent = item.editable ? 'Edit' : 'Locked'
    edit.disabled = !item.editable
    edit.title = item.editable ? 'Edit this daily target' : 'This target is already represented in payroll.'
    edit.addEventListener('click', () => showModal(item))
    actions.appendChild(edit)
    appendCell(row, actions)
    fragment.appendChild(row)
  })
  elements.tableBody.replaceChildren(fragment)
}

async function loadRows() {
  if (loading) return
  setLoading(true)
  setMessage(elements.message, 'Loading daily targets and carryover…')
  try {
    const { data, error } = await supabase.rpc('workforce_admin_list_committed_hours', {
      p_start_date: elements.startDate.value,
      p_end_date: elements.endDate.value,
      p_employee_user_id: elements.employeeFilter.value || null,
      p_team_id: elements.teamFilter.value || null
    })
    if (error) throw error
    const rows = data || []
    renderRows(rows)
    setMessage(elements.message, `${rows.length} target${rows.length === 1 ? '' : 's'} shown. Carryover stays with its original work date.`)
  } catch (error) {
    console.error('Committed Hours targets could not be loaded.', error)
    renderRows([])
    setMessage(elements.message, error.message || 'Committed Hours could not be loaded. Refresh to try again.', 'error')
  } finally {
    setLoading(false)
  }
}

async function loadFilters() {
  const [profileResult, teamResult] = await Promise.all([
    supabase.from('profiles')
      .select('user_id, full_name, email, team_id, is_agent, employment_status')
      .eq('is_agent', true)
      .in('employment_status', ['active', 'on_leave'])
      .order('full_name'),
    supabase.from('teams').select('id, name').order('name')
  ])
  if (profileResult.error) throw profileResult.error
  if (teamResult.error) throw teamResult.error
  employees = profileResult.data || []
  teams = teamResult.data || []
  fillTeamFilter()
  fillEmployeeSelect(elements.employeeFilter, 'All employees')
  fillEmployeeSelect(elements.employee, 'Select employee')
}

async function saveCommitment(event) {
  event.preventDefault()
  if (loading) return
  const targetHours = Number(elements.targetHours.value)
  if (!Number.isFinite(targetHours) || targetHours <= 0 || targetHours > 24) {
    setMessage(elements.formMessage, 'Target hours must be greater than zero and at most 24 hours.', 'error')
    return
  }
  const expectedMinutes = Math.round(targetHours * 60)
  if (expectedMinutes < 1 || expectedMinutes > 1440) {
    setMessage(elements.formMessage, 'Target hours must be between 1 minute and 24 hours.', 'error')
    return
  }

  setLoading(true)
  elements.saveButton.textContent = 'Saving…'
  setMessage(elements.formMessage, 'Saving target…')
  try {
    const { error } = await supabase.rpc('workforce_admin_save_committed_hours', {
      p_commitment_id: elements.commitmentId.value || null,
      p_employee_user_id: elements.employee.value,
      p_work_date: elements.workDate.value,
      p_expected_minutes: expectedMinutes,
      p_reason: elements.reason.value.trim() || null
    })
    if (error) throw error
    closeModal()
    setLoading(false)
    await loadRows()
    setMessage(elements.message, 'Committed Hours target saved.', 'success')
  } catch (error) {
    console.error('Committed Hours target could not be saved.', error)
    setMessage(elements.formMessage, error.message || 'Target could not be saved.', 'error')
  } finally {
    setLoading(false)
    elements.saveButton.textContent = 'Save Commitment'
  }
}

async function initialize() {
  access = await requireWorkforcePermission(supabase, 'manage_employees', {
    returnTo: './workforce.html',
    deniedMessage: 'You do not have permission to manage Committed Hours.'
  })
  if (!access || access.is_admin !== true) return

  elements.tab.hidden = false
  const today = workforceToday()
  const [year, month] = today.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  elements.startDate.value = `${year}-${String(month).padStart(2, '0')}-01`
  elements.endDate.value = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  await loadFilters()
  elements.addButton.addEventListener('click', () => showModal())
  elements.refreshButton.addEventListener('click', loadRows)
  ;[elements.startDate, elements.endDate, elements.employeeFilter]
    .forEach(control => control.addEventListener('change', loadRows))
  elements.teamFilter.addEventListener('change', () => {
    fillEmployeeSelect(elements.employeeFilter, 'All employees')
    loadRows()
  })
  elements.form.addEventListener('submit', saveCommitment)
  document.querySelectorAll('[data-committed-hours-close]').forEach(button => {
    button.addEventListener('click', closeModal)
  })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !elements.modal.hidden) closeModal()
  })
  await loadRows()
}

initialize().catch(error => {
  console.error('Workforce Committed Hours initialization failed.', error)
  setMessage(elements.message, error.message || 'Committed Hours could not be initialized.', 'error')
})
