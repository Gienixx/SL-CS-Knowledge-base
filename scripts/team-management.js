import { supabase } from './supabaseClient.js?v=9'
import {
  requireWorkforcePermission
} from './workforce-permissions.js?v=1'

const tableBody = document.getElementById('teamsTableBody')
const pageMessage = document.getElementById('teamsMessage')
const refreshButton = document.getElementById('refreshTeamsButton')
const createButton = document.getElementById('createTeamButton')
const teamForm = document.getElementById('teamForm')
const formMessage = document.getElementById('teamFormMessage')
const saveButton = document.getElementById('saveTeamButton')

let teams = []
let profiles = []
let lastFocusedElement = null

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
    if (event.key === 'Escape') closeModal('teamModal')
  })
}

function personName(userId) {
  return profiles.find(profile => profile.user_id === userId)?.full_name || 'Not assigned'
}

function memberCount(teamId) {
  return profiles.filter(profile => profile.team_id === teamId).length
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/New_York'
  }).format(date)
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
  document.getElementById('totalTeams').textContent = teams.length
  document.getElementById('activeTeams').textContent = teams.filter(team => team.is_active).length
  document.getElementById('assignedEmployees').textContent = profiles.filter(profile => profile.team_id).length
  document.getElementById('teamsWithoutSupervisor').textContent = teams.filter(team => !team.supervisor_id).length
}

function renderTeams() {
  tableBody.replaceChildren()

  if (!teams.length) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 6
    cell.className = 'wf-empty'
    cell.textContent = 'No teams have been created yet.'
    row.appendChild(cell)
    tableBody.appendChild(row)
    return
  }

  teams.forEach(team => {
    const row = document.createElement('tr')
    const statusCell = document.createElement('td')
    statusCell.appendChild(badge(team.is_active ? 'Active' : 'Inactive', team.is_active ? 'success' : 'muted'))

    const actionCell = document.createElement('td')
    actionCell.className = 'wf-row-actions'
    const editButton = document.createElement('button')
    editButton.type = 'button'
    editButton.className = 'wf-row-btn'
    editButton.textContent = 'Edit'
    editButton.addEventListener('click', () => openTeam(team.id))
    actionCell.appendChild(editButton)

    row.append(
      textCell(team.name, team.description || ''),
      textCell(personName(team.supervisor_id)),
      textCell(String(memberCount(team.id))),
      statusCell,
      textCell(formatDate(team.updated_at)),
      actionCell
    )

    tableBody.appendChild(row)
  })
}

function populateSupervisors() {
  const select = document.getElementById('teamSupervisor')
  select.replaceChildren(new Option('No supervisor', ''))

  profiles
    .filter(profile => ['active', 'on_leave'].includes(profile.employment_status))
    .sort((a, b) => a.full_name.localeCompare(b.full_name))
    .forEach(profile => {
      select.appendChild(new Option(
        `${profile.full_name} — ${profile.employee_id}`,
        profile.user_id
      ))
    })
}

function openTeam(teamId = '') {
  const team = teams.find(item => item.id === teamId) || null
  document.getElementById('teamModalTitle').textContent = team ? 'Edit Team' : 'Create Team'
  document.getElementById('teamId').value = team?.id || ''
  document.getElementById('teamName').value = team?.name || ''
  document.getElementById('teamDescription').value = team?.description || ''
  document.getElementById('teamSupervisor').value = team?.supervisor_id || ''
  document.getElementById('teamIsActive').checked = team ? team.is_active === true : true
  document.getElementById('teamChangeReason').value = ''
  setMessage(formMessage, '')
  openModal('teamModal', document.getElementById('teamName'))
}

async function loadTeamData() {
  setLoading(refreshButton, true, 'Refreshing...', 'Refresh')
  setMessage(pageMessage, 'Loading teams...')

  try {
    const [teamResult, profileResult] = await Promise.all([
      supabase
        .from('teams')
        .select('id, name, description, supervisor_id, is_active, updated_at')
        .order('name'),
      supabase
        .from('profiles')
        .select('user_id, full_name, employee_id, employment_status, team_id')
        .order('full_name')
    ])

    if (teamResult.error) throw teamResult.error
    if (profileResult.error) throw profileResult.error

    teams = teamResult.data || []
    profiles = profileResult.data || []
    populateSupervisors()
    renderSummary()
    renderTeams()
    setMessage(pageMessage, `${teams.length} team${teams.length === 1 ? '' : 's'} loaded.`)
  } catch (error) {
    teams = []
    profiles = []
    renderTeams()
    setMessage(pageMessage, errorMessage(error), 'error')
  } finally {
    setLoading(refreshButton, false, 'Refreshing...', 'Refresh')
  }
}

async function saveTeam(event) {
  event.preventDefault()

  const teamId = document.getElementById('teamId').value || null
  const name = normalizeText(document.getElementById('teamName').value)
  const description = normalizeText(document.getElementById('teamDescription').value) || null
  const supervisorId = document.getElementById('teamSupervisor').value || null
  const isActive = document.getElementById('teamIsActive').checked
  const reason = normalizeText(document.getElementById('teamChangeReason').value) || null

  if (!name) {
    setMessage(formMessage, 'Team name is required.', 'error')
    return
  }

  setLoading(saveButton, true, 'Saving...', 'Save Team')
  setMessage(formMessage, 'Saving team...')

  try {
    const { error } = await supabase.rpc('workforce_admin_save_team', {
      p_team_id: teamId,
      p_name: name,
      p_description: description,
      p_supervisor_id: supervisorId,
      p_is_active: isActive,
      p_reason: reason
    })

    if (error) throw error

    setMessage(formMessage, 'Team saved successfully.', 'success')
    await loadTeamData()
    window.setTimeout(() => closeModal('teamModal'), 650)
  } catch (error) {
    setMessage(formMessage, errorMessage(error), 'error')
  } finally {
    setLoading(saveButton, false, 'Saving...', 'Save Team')
  }
}

async function initialize() {
  initializeModalControls()

  const access = await requireWorkforcePermission(supabase, 'manage_employees', {
    returnTo: './team-management.html',
    deniedMessage: 'You do not have permission to manage workforce teams.'
  })

  if (!access) return

  if (access.is_admin !== true) {
    window.alert('Team administration is restricted to authorized administrators.')
    window.location.replace('./dashboard.html')
    return
  }

  refreshButton.addEventListener('click', loadTeamData)
  createButton.addEventListener('click', () => openTeam())
  teamForm.addEventListener('submit', saveTeam)

  await loadTeamData()
}

initialize().catch(error => {
  console.error('Team management initialization failed:', error)
  setMessage(pageMessage, errorMessage(error), 'error')
})
