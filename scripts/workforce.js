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
const openInviteButton = document.getElementById('openEmployeeInviteButton')
const inviteForm = document.getElementById('employeeInviteForm')
const inviteMessage = document.getElementById('employeeInviteMessage')
const sendInviteButton = document.getElementById('sendEmployeeInviteButton')
const inviteAccessType = document.getElementById('inviteEmployeeAccessType')

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
  regular_agent: 'Regular Agent'
})

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function errorMessage(error) {
  return error?.message || 'An unexpected error occurred.'
}

async function authenticatedRequest(endpoint, options = {}) {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
  if (sessionError) throw sessionError
  const accessToken = sessionData.session?.access_token
  if (!accessToken) throw new Error('Your session has expired. Sign in again.')

  const response = await fetch(endpoint, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {})
    }
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.')
  return data
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
    if (event.key === 'Escape') {
      closeModal('employeeModal')
      closeModal('employeeInviteModal')
    }
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

function userCell(profile) {
  const cell = document.createElement('td')
  const wrap = document.createElement('div')
  wrap.className = 'wf-user-cell'
  const avatar = document.createElement('span')
  const paletteIndex = [...normalizeText(profile.full_name)].reduce((total, character) => total + character.charCodeAt(0), 0) % 4
  avatar.className = `wf-avatar palette-${paletteIndex}`
  avatar.textContent = normalizeText(profile.full_name).split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'U'
  const details = document.createElement('span')
  const name = document.createElement('strong')
  name.textContent = profile.full_name || '—'
  const meta = document.createElement('small')
  meta.textContent = [profile.email, profile.employee_id].filter(Boolean).join(' · ')
  details.append(name, meta)
  wrap.append(avatar, details)
  cell.appendChild(wrap)
  return cell
}

function teamCell(teamId) {
  const cell = document.createElement('td')
  const wrap = document.createElement('span')
  wrap.className = `wf-team-cell${teamId ? '' : ' unassigned'}`
  const dot = document.createElement('i')
  if (teamId) {
    const paletteIndex = [...teamId].reduce((total, character) => total + character.charCodeAt(0), 0) % 3
    dot.className = `palette-${paletteIndex}`
  }
  const name = document.createElement('span')
  name.textContent = teamName(teamId)
  wrap.append(dot, name)
  cell.appendChild(wrap)
  return cell
}

function renderSummary() {
  document.getElementById('totalProfiles').textContent = profiles.length
  document.getElementById('activeAgents').textContent = profiles.filter(profile =>
    profile.is_agent === true &&
    profile.onboarding_status === 'active' &&
    ['active', 'on_leave'].includes(profile.employment_status)
  ).length
  document.getElementById('administratorCount').textContent = profiles.filter(profile =>
    profile.base_role === 'admin' &&
    profile.onboarding_status === 'active' &&
    ['active', 'on_leave'].includes(profile.employment_status)
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

    const matchesStatus = !status || (
      status === 'invited'
        ? profile.onboarding_status === 'invited'
        : profile.employment_status === status
    )
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
    cell.colSpan = 7
    cell.className = 'wf-empty'
    cell.textContent = 'No user profiles match the selected filters.'
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
    const accessType = accessTypeFor(profile)
    accessCell.appendChild(badge(
      ACCESS_LABELS[accessType] || 'Regular Agent',
      accessType === 'admin' || accessType === 'admin_agent' ? 'admin' : 'agent'
    ))

    const statusCell = document.createElement('td')
    if (profile.onboarding_status === 'invited') {
      statusCell.appendChild(badge('Invited', 'warning'))
    }
    statusCell.appendChild(badge(
      STATUS_LABELS[profile.employment_status] || profile.employment_status,
      statusModifier(profile.employment_status)
    ))

    const permissionCell = document.createElement('td')
    permissionCell.className = 'wf-permission-cell'
    const permissionCount = document.createElement('strong')
    permissionCount.textContent = String(grantedCount)
    permissionCell.append(permissionCount, document.createTextNode(' granted'))

    const actionCell = document.createElement('td')
    actionCell.className = 'wf-row-actions'
    const editButton = document.createElement('button')
    editButton.type = 'button'
    editButton.className = 'wf-row-btn wf-profile-edit'
    editButton.textContent = 'Edit'
    editButton.addEventListener('click', () => openEmployee(profile.user_id))
    actionCell.appendChild(editButton)

    const menuButton = document.createElement('button')
    menuButton.type = 'button'
    menuButton.className = 'wf-kebab'
    menuButton.textContent = '⋯'
    menuButton.setAttribute('aria-label', `More actions for ${profile.full_name}`)
    menuButton.setAttribute('aria-expanded', 'false')
    const actionMenu = document.createElement('div')
    actionMenu.className = 'wf-action-menu'
    menuButton.addEventListener('click', event => {
      event.stopPropagation()
      document.querySelectorAll('.wf-action-menu.open').forEach(menu => {
        if (menu !== actionMenu) menu.classList.remove('open')
      })
      actionMenu.classList.toggle('open')
      menuButton.setAttribute('aria-expanded', String(actionMenu.classList.contains('open')))
    })
    if (profile.onboarding_status === 'invited') {
      const resendButton = document.createElement('button')
      resendButton.type = 'button'
      resendButton.className = 'wf-row-btn'
      resendButton.textContent = 'Resend invite'
      resendButton.addEventListener('click', () => resendInvitation(profile, resendButton))
      actionMenu.appendChild(resendButton)
    }
    if (profile.employment_status === 'inactive') {
      actionMenu.appendChild(lifecycleButton(profile, 'Reactivate', 'reactivate'))
    } else if (profile.employment_status !== 'terminated') {
      actionMenu.appendChild(lifecycleButton(profile, 'Deactivate', 'deactivate'))
    }
    if (!profile.account_deleted_at) {
      actionMenu.appendChild(lifecycleButton(profile, 'Delete account', 'delete', true))
    }
    actionCell.append(menuButton, actionMenu)

    row.append(
      userCell(profile),
      accessCell,
      teamCell(profile.team_id),
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
  const inviteTeam = document.getElementById('inviteEmployeeTeam')
  inviteTeam.replaceChildren(new Option('No team', ''))

  teams
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(team => {
      teamFilter.appendChild(new Option(team.name, team.id))
      employeeTeam.appendChild(new Option(
        team.is_active ? team.name : `${team.name} (Inactive)`,
        team.id
      ))
      if (team.is_active) inviteTeam.appendChild(new Option(team.name, team.id))
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

function populateInviteSupervisorOptions() {
  const select = document.getElementById('inviteEmployeeSupervisor')
  select.replaceChildren(new Option('No direct supervisor', ''))
  profiles
    .filter(profile =>
      profile.onboarding_status === 'active' &&
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

function readInvitePermissions() {
  return Object.fromEntries(
    [...document.querySelectorAll('#invitePermissionGrid input[type="checkbox"]')]
      .map(input => [input.value, input.checked])
  )
}

function applyInviteAccessTypeRules() {
  const isAdmin = ['admin', 'admin_agent'].includes(inviteAccessType.value)
  const adminPermissions = new Set([
    'manage_employees', 'manage_schedules', 'view_team_attendance',
    'correct_attendance', 'approve_attendance', 'approve_leave',
    'view_workforce_reports', 'manage_payroll'
  ])
  document.querySelectorAll('#invitePermissionGrid input[type="checkbox"]').forEach(input => {
    if (adminPermissions.has(input.value)) input.checked = isAdmin
  })
}

function openEmployeeInvitation() {
  inviteForm.reset()
  inviteAccessType.value = 'regular_agent'
  applyInviteAccessTypeRules()
  populateInviteSupervisorOptions()
  setMessage(inviteMessage, '')
  openModal('employeeInviteModal', document.getElementById('inviteEmployeeName'))
}

async function sendEmployeeInvitation(event) {
  event.preventDefault()
  const name = normalizeText(document.getElementById('inviteEmployeeName').value)
  const email = normalizeText(document.getElementById('inviteEmployeeEmail').value).toLowerCase()

  setLoading(sendInviteButton, true, 'Sending...', 'Send Invitation')
  setMessage(inviteMessage, 'Creating the user profile and sending the invitation...')
  try {
    const result = await authenticatedRequest('/create-user', {
      method: 'POST',
      body: JSON.stringify({
        name,
        email,
        accessType: inviteAccessType.value,
        permissions: readInvitePermissions(),
        teamId: document.getElementById('inviteEmployeeTeam').value || null,
        supervisorId: document.getElementById('inviteEmployeeSupervisor').value || null
      })
    })
    setMessage(
      inviteMessage,
      `Invitation sent. User ${result.employee?.employee_id || ''} was created.`,
      'success'
    )
    await loadWorkforceData()
    window.setTimeout(() => closeModal('employeeInviteModal'), 900)
  } catch (error) {
    setMessage(inviteMessage, errorMessage(error), 'error')
  } finally {
    setLoading(sendInviteButton, false, 'Sending...', 'Send Invitation')
  }
}

async function resendInvitation(profile, button) {
  setLoading(button, true, 'Sending...', 'Resend invite')
  setMessage(pageMessage, `Sending a new invitation to ${profile.email}...`)
  try {
    await authenticatedRequest('/resend-invite', {
      method: 'POST',
      body: JSON.stringify({ userId: profile.user_id })
    })
    setMessage(pageMessage, `Invitation resent to ${profile.email}.`, 'success')
    await loadWorkforceData()
  } catch (error) {
    setMessage(pageMessage, errorMessage(error), 'error')
  } finally {
    setLoading(button, false, 'Sending...', 'Resend invite')
  }
}

function lifecycleButton(profile, label, action, destructive = false) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `wf-row-btn${destructive ? ' danger' : ''}`
  button.textContent = label
  button.addEventListener('click', () => changeEmployeeLifecycle(profile, action, button))
  return button
}

async function changeEmployeeLifecycle(profile, action, button) {
  const verb = action === 'delete' ? 'delete this account' : `${action} this user`
  if (!window.confirm(`Are you sure you want to ${verb}? Workforce history will be preserved.`)) return

  let confirmation
  if (action === 'delete') {
    confirmation = window.prompt(`Type DELETE to remove ${profile.email}'s sign-in account. Attendance, schedules, and audit history will remain.`)
    if (confirmation !== 'DELETE') {
      setMessage(pageMessage, 'Account deletion cancelled.', 'error')
      return
    }
  }

  const originalLabel = button.textContent
  setLoading(button, true, 'Working...', originalLabel)
  try {
    await authenticatedRequest('/employee-lifecycle', {
      method: 'POST',
      body: JSON.stringify({ userId: profile.user_id, action, confirmation })
    })
    setMessage(pageMessage, `${profile.full_name} was ${action === 'delete' ? 'deleted' : `${action}d`} successfully.`, 'success')
    await loadWorkforceData()
  } catch (error) {
    setMessage(pageMessage, errorMessage(error), 'error')
  } finally {
    setLoading(button, false, 'Working...', originalLabel)
  }
}

function applyAccessTypeRules() {
  const permissionInputs = [
    ...document.querySelectorAll('#permissionGrid input[type="checkbox"]')
  ]
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
  setMessage(pageMessage, 'Loading user profiles...')

  try {
    const [profileResult, teamResult] = await Promise.all([
      supabase
        .from('profiles')
        .select('user_id, full_name, email, employee_id, employment_status, onboarding_status, invited_at, invitation_last_sent_at, account_deleted_at, base_role, is_agent, is_system_admin, team_id, supervisor_id, can_edit_articles, can_manage_payroll, timezone, updated_at')
        .eq('is_system_admin', false)
        .is('account_deleted_at', null)
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
    populateInviteSupervisorOptions()
    renderSummary()
    renderEmployees()
    setMessage(pageMessage, `${profiles.length} user profile${profiles.length === 1 ? '' : 's'} loaded.`)
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
  const email = normalizeText(document.getElementById('employeeEmail').value).toLowerCase()
  const employeeId = normalizeText(document.getElementById('employeeId').value)
  const employmentStatus = document.getElementById('employmentStatus').value
  const accessType = accessTypeSelect.value
  const teamId = document.getElementById('employeeTeam').value || null
  const supervisorId = document.getElementById('employeeSupervisor').value || null
  const timezone = normalizeText(document.getElementById('employeeTimezone').value) || 'America/New_York'
  const reason = normalizeText(document.getElementById('employeeChangeReason').value) || null
  const permissions = readPermissionCheckboxes()
  const profile = profiles.find(item => item.user_id === userId)

  if (!userId || !fullName || !email || !employeeId) {
    setMessage(formMessage, 'Full name, email, and user ID are required.', 'error')
    return
  }

  if (profile?.is_system_admin === true) {
    WORKFORCE_PERMISSION_KEYS.forEach(key => {
      permissions[key] = true
    })
  }

  setLoading(saveButton, true, 'Saving...', 'Save User')
  setMessage(formMessage, 'Saving user profile and permissions...')

  try {
    await authenticatedRequest('/update-employee', {
      method: 'POST',
      body: JSON.stringify({
        userId,
        fullName,
        email,
        employeeId,
        employmentStatus,
        accessType,
        teamId,
        supervisorId,
        timezone,
        permissions,
        reason
      })
    })

    setMessage(formMessage, 'User profile updated successfully.', 'success')
    await loadWorkforceData()
    window.setTimeout(() => closeModal('employeeModal'), 650)
  } catch (error) {
    setMessage(formMessage, errorMessage(error), 'error')
  } finally {
    setLoading(saveButton, false, 'Saving...', 'Save User')
  }
}

async function initialize() {
  initializeModalControls()

  access = await requireWorkforcePermission(supabase, 'manage_employees', {
    returnTo: './workforce.html',
    deniedMessage: 'You do not have permission to manage workforce users.'
  })

  if (!access) return

  if (access.is_admin !== true) {
    window.alert('User administration is restricted to authorized administrators.')
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
  openInviteButton.addEventListener('click', openEmployeeInvitation)
  inviteAccessType.addEventListener('change', applyInviteAccessTypeRules)
  inviteForm.addEventListener('submit', sendEmployeeInvitation)
  document.addEventListener('click', event => {
    if (event.target.closest('.wf-row-actions')) return
    document.querySelectorAll('.wf-action-menu.open').forEach(menu => menu.classList.remove('open'))
    document.querySelectorAll('.wf-kebab[aria-expanded="true"]').forEach(button => button.setAttribute('aria-expanded', 'false'))
  })

  await loadWorkforceData()
}

initialize().catch(error => {
  console.error('Workforce initialization failed:', error)
  setMessage(pageMessage, errorMessage(error), 'error')
})
