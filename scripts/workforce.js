import { supabase } from './supabaseClient.js?v=9'
import {
  requireWorkforcePermission
} from './workforce-permissions.js?v=1'
import {
  WORKFORCE_PERMISSION_KEYS,
  getWorkforceAccessType
} from '../shared/workforce-access.js'

const tableBody = document.getElementById('employeeTableBody')
const pageMessage = document.getElementById('employeesMessage')
const refreshButton = document.getElementById('refreshEmployeesButton')
const searchInput = document.getElementById('employeeSearch')
const statusFilter = document.getElementById('statusFilter')
const teamFilter = document.getElementById('teamFilter')
const employeeForm = document.getElementById('employeeForm')
const formMessage = document.getElementById('employeeFormMessage')
const saveButton = document.getElementById('saveEmployeeButton')
const accessTypeSelect = document.getElementById('accessType')
const tablePagination = document.getElementById('employeeTablePagination')
const tablePageInfo = document.getElementById('employeeTablePageInfo')
const tablePreviousButton = document.getElementById('previousEmployeeTablePage')
const tableNextButton = document.getElementById('nextEmployeeTablePage')

let access = null
let profiles = []
let teams = []
let permissionsByUser = new Map()
let lastFocusedElement = null
let editingSystemAdmin = false
let employeePage = 1

const EMPLOYEE_PAGE_SIZE = 5

const STATUS_LABELS = Object.freeze({
  active: 'Active',
  on_leave: 'On leave',
  inactive: 'Inactive',
  terminated: 'Terminated'
})

const ACCESS_LABELS = Object.freeze({
  admin_agent: 'Admin and Agent',
  admin: 'Admin',
  agent_editor: 'Agent with Article Editor access',
  regular_agent: 'Regular Agent'
})

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function errorMessage(error) {
  return error?.message || 'An unexpected error occurred.'
}

function setMessage(element, text, type = '') {
  if (!element) return
  element.textContent = text
  element.className = type ? `wf-message ${type}` : 'wf-message'
}

function setLoading(button, loading, loadingText, readyText) {
  if (!button) return
  button.disabled = loading
  button.textContent = loading ? loadingText : readyText
}

function openModal(id, focusElement) {
  const modal = document.getElementById(id)
  if (!modal) return
  lastFocusedElement = document.activeElement
  modal.hidden = false
  document.body.classList.add('modal-open')
  requestAnimationFrame(() => focusElement?.focus())
}

function closeModal(id) {
  const modal = document.getElementById(id)
  if (!modal) return
  modal.hidden = true
  document.body.classList.remove('modal-open')
  if (lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus()
}

function initializeModalControls() {
  document.querySelectorAll('[data-close]').forEach(button => {
    button.addEventListener('click', () => closeModal(button.dataset.close))
  })

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeModal('employeeModal')
  })
}

function profilePermissions(userId) {
  return permissionsByUser.get(userId) || Object.fromEntries(
    WORKFORCE_PERMISSION_KEYS.map(key => [key, false])
  )
}

function accessTypeFor(profile) {
  return getWorkforceAccessType({
    is_admin: profile.base_role === 'admin',
    is_agent: profile.is_agent === true,
    is_system_admin: profile.is_system_admin === true,
    permissions: profilePermissions(profile.user_id)
  })
}

function teamName(teamId) {
  return teams.find(team => team.id === teamId)?.name || 'Unassigned'
}

function personName(userId) {
  return profiles.find(profile => profile.user_id === userId)?.full_name || '—'
}

function badge(text, modifier = '') {
  const span = document.createElement('span')
  span.className = modifier ? `wf-badge ${modifier}` : 'wf-badge'
  span.textContent = text
  return span
}

function textCell(primary, secondary = '') {
  const cell = document.createElement('td')
  const main = document.createElement('span')
  main.className = 'wf-person'
  main.textContent = primary || '—'
  cell.appendChild(main)

  if (secondary) {
    const sub = document.createElement('span')
    sub.className = 'wf-subtext'
    sub.textContent = secondary
    cell.appendChild(sub)
  }

  return cell
}

function renderSummary() {
  document.getElementById('totalProfiles').textContent = profiles.length
  document.getElementById('activeAgents').textContent = profiles.filter(profile =>
    profile.is_agent === true && ['active', 'on_leave'].includes(profile.employment_status)
  ).length
  document.getElementById('administratorCount').textContent = profiles.filter(profile =>
    profile.base_role === 'admin' && ['active', 'on_leave'].includes(profile.employment_status)
  ).length
  document.getElementById('unassignedCount').textContent = profiles.filter(profile => !profile.team_id).length
}

function filteredProfiles() {
  const search = normalizeText(searchInput.value).toLowerCase()
  const status = statusFilter.value
  const selectedTeam = teamFilter.value

  return profiles.filter(profile => {
    const matchesSearch = !search || [
      profile.full_name,
      profile.email,
      profile.employee_id
    ].some(value => normalizeText(value).toLowerCase().includes(search))

    const matchesStatus = !status || profile.employment_status === status
    const matchesTeam = !selectedTeam || (
      selectedTeam === 'unassigned'
        ? !profile.team_id
        : profile.team_id === selectedTeam
    )

    return matchesSearch && matchesStatus && matchesTeam
  })
}

function statusModifier(status) {
  if (status === 'active') return 'success'
  if (status === 'on_leave') return 'warning'
  if (status === 'terminated') return 'danger'
  return 'muted'
}

function renderEmployees() {
  tableBody.replaceChildren()
  const rows = filteredProfiles()

  if (!rows.length) {
    tablePagination.hidden = true
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 8
    cell.className = 'wf-empty'
    cell.textContent = 'No employee profiles match the selected filters.'
    row.appendChild(cell)
    tableBody.appendChild(row)
    return
  }

  const pageCount = Math.ceil(rows.length / EMPLOYEE_PAGE_SIZE)
  employeePage = Math.min(Math.max(employeePage, 1), pageCount)
  const pageStart = (employeePage - 1) * EMPLOYEE_PAGE_SIZE
  const pageRows = rows.slice(pageStart, pageStart + EMPLOYEE_PAGE_SIZE)

  tablePagination.hidden = rows.length <= EMPLOYEE_PAGE_SIZE
  tablePageInfo.textContent = `Page ${employeePage} of ${pageCount}`
  tablePreviousButton.disabled = employeePage === 1
  tableNextButton.disabled = employeePage === pageCount

  pageRows.forEach(profile => {
    const row = document.createElement('tr')
    const permissions = profilePermissions(profile.user_id)
    const grantedCount = WORKFORCE_PERMISSION_KEYS.filter(key => permissions[key] === true).length

    const accessCell = document.createElement('td')
    accessCell.appendChild(badge(ACCESS_LABELS[accessTypeFor(profile)] || 'Regular Agent'))

    const statusCell = document.createElement('td')
    statusCell.appendChild(badge(
      STATUS_LABELS[profile.employment_status] || profile.employment_status,
      statusModifier(profile.employment_status)
    ))

    const permissionCell = document.createElement('td')
    permissionCell.appendChild(badge(`${grantedCount} granted`, grantedCount ? 'success' : 'muted'))

    const actionCell = document.createElement('td')
    actionCell.className = 'wf-row-actions'
    const editButton = document.createElement('button')
    editButton.type = 'button'
    editButton.className = 'wf-row-btn'
    editButton.textContent = 'Edit'
    editButton.addEventListener('click', () => openEmployee(profile.user_id))
    actionCell.appendChild(editButton)

    row.append(
      textCell(profile.full_name, profile.email),
      textCell(profile.employee_id),
      accessCell,
      textCell(teamName(profile.team_id)),
      textCell(personName(profile.supervisor_id)),
      statusCell,
      permissionCell,
      actionCell
    )

    tableBody.appendChild(row)
  })
}

function populateTeamOptions() {
  const currentFilter = teamFilter.value
  teamFilter.replaceChildren(new Option('All teams', ''), new Option('Unassigned', 'unassigned'))

  const employeeTeam = document.getElementById('employeeTeam')
  employeeTeam.replaceChildren(new Option('No team', ''))

  teams
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(team => {
      teamFilter.appendChild(new Option(team.name, team.id))
      employeeTeam.appendChild(new Option(
        team.is_active ? team.name : `${team.name} (Inactive)`,
        team.id
      ))
    })

  if ([...teamFilter.options].some(option => option.value === currentFilter)) {
    teamFilter.value = currentFilter
  }
}

function populateSupervisorOptions(excludedUserId = '') {
  const select = document.getElementById('employeeSupervisor')
  select.replaceChildren(new Option('No direct supervisor', ''))

  profiles
    .filter(profile =>
      profile.user_id !== excludedUserId &&
      ['active', 'on_leave'].includes(profile.employment_status)
    )
    .sort((a, b) => a.full_name.localeCompare(b.full_name))
    .forEach(profile => {
      select.appendChild(new Option(
        `${profile.full_name} — ${profile.employee_id}`,
        profile.user_id
      ))
    })
}

function setPermissionCheckboxes(permissionMap) {
  document.querySelectorAll('#permissionGrid input[type="checkbox"]').forEach(input => {
    input.checked = permissionMap[input.value] === true
  })
}

function readPermissionCheckboxes() {
  return Object.fromEntries(
    [...document.querySelectorAll('#permissionGrid input[type="checkbox"]')]
      .map(input => [input.value, input.checked])
  )
}

function applyAccessTypeRules() {
  const permissionInputs = [
    ...document.querySelectorAll('#permissionGrid input[type="checkbox"]')
  ]
  const editArticles = permissionInputs.find(input => input.value === 'edit_articles')

  if (editingSystemAdmin) {
    accessTypeSelect.disabled = true
    permissionInputs.forEach(input => {
      input.checked = true
      input.disabled = true
    })
    return
  }

  accessTypeSelect.disabled = false
  permissionInputs.forEach(input => {
    input.disabled = false
  })

  if (!editArticles) return

  const selected = accessTypeSelect.value

  if (selected === 'agent_editor') {
    editArticles.checked = true
    editArticles.disabled = true
  } else if (selected === 'regular_agent') {
    editArticles.checked = false
    editArticles.disabled = true
  }
}

function openEmployee(userId) {
  const profile = profiles.find(item => item.user_id === userId)
  if (!profile) return

  editingSystemAdmin = profile.is_system_admin === true

  document.getElementById('employeeUserId').value = profile.user_id
  document.getElementById('employeeFullName').value = profile.full_name || ''
  document.getElementById('employeeEmail').value = profile.email || ''
  document.getElementById('employeeId').value = profile.employee_id || ''
  document.getElementById('employmentStatus').value = profile.employment_status
  document.getElementById('accessType').value = accessTypeFor(profile)
  document.getElementById('employeeTimezone').value = profile.timezone || 'America/New_York'
  document.getElementById('employeeTeam').value = profile.team_id || ''
  document.getElementById('employeeChangeReason').value = ''

  populateSupervisorOptions(profile.user_id)
  document.getElementById('employeeSupervisor').value = profile.supervisor_id || ''
  setPermissionCheckboxes(profilePermissions(profile.user_id))
  applyAccessTypeRules()
  setMessage(formMessage, '')
  openModal('employeeModal', document.getElementById('employeeFullName'))
}

async function loadWorkforceData() {
  employeePage = 1
  setLoading(refreshButton, true, 'Refreshing...', 'Refresh')
  setMessage(pageMessage, 'Loading employee profiles...')

  try {
    const [profileResult, teamResult] = await Promise.all([
      supabase
        .from('profiles')
        .select('user_id, full_name, email, employee_id, employment_status, base_role, is_agent, is_system_admin, team_id, supervisor_id, can_edit_articles, can_manage_payroll, timezone, updated_at')
        .eq('is_system_admin', false)
        .order('full_name'),
      supabase
        .from('teams')
        .select('id, name, description, is_active, updated_at')
        .order('name')
    ])

    if (profileResult.error) throw profileResult.error
    if (teamResult.error) throw teamResult.error

    const visibleProfiles = profileResult.data || []
    const visibleUserIds = visibleProfiles.map(profile => profile.user_id)
    const permissionResult = visibleUserIds.length
      ? await supabase
        .from('user_permissions')
        .select('user_id, permission_key, is_granted')
        .in('user_id', visibleUserIds)
      : { data: [], error: null }

    if (permissionResult.error) throw permissionResult.error

    profiles = visibleProfiles
    teams = teamResult.data || []
    permissionsByUser = new Map()

    for (const profile of profiles) {
      permissionsByUser.set(profile.user_id, Object.fromEntries(
        WORKFORCE_PERMISSION_KEYS.map(key => [key, false])
      ))
    }

    for (const permission of permissionResult.data || []) {
      const map = permissionsByUser.get(permission.user_id) || {}
      map[permission.permission_key] = permission.is_granted === true
      permissionsByUser.set(permission.user_id, map)
    }

    populateTeamOptions()
    renderSummary()
    renderEmployees()
    setMessage(pageMessage, `${profiles.length} employee profile${profiles.length === 1 ? '' : 's'} loaded.`)
  } catch (error) {
    profiles = []
    teams = []
    permissionsByUser = new Map()
    renderEmployees()
    setMessage(pageMessage, errorMessage(error), 'error')
  } finally {
    setLoading(refreshButton, false, 'Refreshing...', 'Refresh')
  }
}

async function saveEmployee(event) {
  event.preventDefault()

  const userId = document.getElementById('employeeUserId').value
  const fullName = normalizeText(document.getElementById('employeeFullName').value)
  const employeeId = normalizeText(document.getElementById('employeeId').value)
  const employmentStatus = document.getElementById('employmentStatus').value
  const accessType = accessTypeSelect.value
  const teamId = document.getElementById('employeeTeam').value || null
  const supervisorId = document.getElementById('employeeSupervisor').value || null
  const timezone = normalizeText(document.getElementById('employeeTimezone').value) || 'America/New_York'
  const reason = normalizeText(document.getElementById('employeeChangeReason').value) || null
  const permissions = readPermissionCheckboxes()
  const profile = profiles.find(item => item.user_id === userId)

  if (!userId || !fullName || !employeeId) {
    setMessage(formMessage, 'Full name and employee ID are required.', 'error')
    return
  }

  if (profile?.is_system_admin === true) {
    WORKFORCE_PERMISSION_KEYS.forEach(key => {
      permissions[key] = true
    })
  } else {
    if (accessType === 'agent_editor') permissions.edit_articles = true
    if (accessType === 'regular_agent') permissions.edit_articles = false
  }

  setLoading(saveButton, true, 'Saving...', 'Save Employee')
  setMessage(formMessage, 'Saving employee profile and permissions...')

  try {
    const { error } = await supabase.rpc('workforce_admin_save_employee', {
      p_user_id: userId,
      p_full_name: fullName,
      p_employee_id: employeeId,
      p_employment_status: employmentStatus,
      p_access_type: accessType,
      p_team_id: teamId,
      p_supervisor_id: supervisorId,
      p_timezone: timezone,
      p_permissions: permissions,
      p_reason: reason
    })

    if (error) throw error

    setMessage(formMessage, 'Employee profile updated successfully.', 'success')
    await loadWorkforceData()
    window.setTimeout(() => closeModal('employeeModal'), 650)
  } catch (error) {
    setMessage(formMessage, errorMessage(error), 'error')
  } finally {
    setLoading(saveButton, false, 'Saving...', 'Save Employee')
  }
}

async function initialize() {
  initializeModalControls()

  access = await requireWorkforcePermission(supabase, 'manage_employees', {
    returnTo: './workforce.html',
    deniedMessage: 'You do not have permission to manage workforce employees.'
  })

  if (!access) return

  if (access.is_admin !== true) {
    window.alert('Employee administration is restricted to authorized administrators.')
    window.location.replace('./dashboard.html')
    return
  }

  refreshButton.addEventListener('click', loadWorkforceData)
  searchInput.addEventListener('input', () => {
    employeePage = 1
    renderEmployees()
  })
  statusFilter.addEventListener('change', () => {
    employeePage = 1
    renderEmployees()
  })
  teamFilter.addEventListener('change', () => {
    employeePage = 1
    renderEmployees()
  })
  tablePreviousButton.addEventListener('click', () => {
    if (employeePage <= 1) return
    employeePage -= 1
    renderEmployees()
  })
  tableNextButton.addEventListener('click', () => {
    employeePage += 1
    renderEmployees()
  })
  accessTypeSelect.addEventListener('change', applyAccessTypeRules)
  employeeForm.addEventListener('submit', saveEmployee)

  await loadWorkforceData()
}

initialize().catch(error => {
  console.error('Workforce initialization failed:', error)
  setMessage(pageMessage, errorMessage(error), 'error')
})
