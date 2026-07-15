import { supabase } from './supabaseClient.js?v=9'

const tableBody = document.getElementById('usersTableBody')
const usersMessage = document.getElementById('usersMessage')
const refreshButton = document.getElementById('refreshUsersButton')
let currentSession = null

function setMessage(text, type = '') {
  usersMessage.textContent = text
  usersMessage.className = type ? `um-message ${type}` : 'um-message'
}

function statusCell(enabled) {
  const cell = document.createElement('td')
  const badge = document.createElement('span')
  badge.className = `um-status ${enabled ? 'yes' : 'no'}`
  badge.textContent = enabled ? 'Yes' : 'No'
  cell.appendChild(badge)
  return cell
}

function textCell(value, className = '') {
  const cell = document.createElement('td')
  cell.textContent = value || '—'
  if (className) cell.className = className
  return cell
}

async function requireAdmin() {
  const { data: { session }, error } = await supabase.auth.getSession()
  if (error) throw error
  if (!session?.access_token) {
    window.location.replace('./login.html')
    return null
  }
  const { data, error: accessError } = await supabase
    .from('login').select('is_admin').ilike('email', session.user.email).maybeSingle()
  if (accessError) throw accessError
  if (data?.is_admin !== true) {
    window.location.replace('./dashboard.html')
    return null
  }
  return session
}

async function loadUsers() {
  refreshButton.disabled = true
  refreshButton.textContent = 'Refreshing...'
  setMessage('Running compatibility parity checks...')
  try {
    const response = await fetch('/list-users', {
      headers: { Authorization: `Bearer ${currentSession.access_token}` }
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Unable to load users.')
    const users = Array.isArray(result.users) ? result.users : []
    tableBody.replaceChildren()
    users.forEach(user => {
      const row = document.createElement('tr')
      const parity = document.createElement('td')
      const badge = document.createElement('span')
      badge.className = `um-status ${user.parity_ok ? 'yes' : 'no'}`
      badge.textContent = user.parity_ok ? 'Match' : user.parity_issue || 'Review'
      parity.appendChild(badge)
      row.append(
        textCell(user.employee_id, 'um-id'), textCell(user.name), textCell(user.email),
        statusCell(user.is_admin), statusCell(user.can_edit_articles), parity
      )
      tableBody.appendChild(row)
    })
    if (!users.length) {
      const row = document.createElement('tr')
      const cell = textCell('No compatibility users were found.', 'um-empty')
      cell.colSpan = 6
      row.appendChild(cell)
      tableBody.appendChild(row)
    }
    const mismatches = users.filter(user => !user.parity_ok).length
    setMessage(
      mismatches ? `${users.length} users compared; ${mismatches} require review.` : `${users.length} users compared; all records match.`,
      mismatches ? 'error' : 'success'
    )
  } catch (error) {
    setMessage(error.message || 'Unable to load users.', 'error')
  } finally {
    refreshButton.disabled = false
    refreshButton.textContent = 'Refresh'
  }
}

async function initialize() {
  currentSession = await requireAdmin()
  if (!currentSession) return
  refreshButton.addEventListener('click', loadUsers)
  await loadUsers()
}

initialize().catch(error => {
  console.error('Read-only user comparison failed:', error)
  setMessage('Unable to verify administrator access.', 'error')
})
