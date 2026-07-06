import { supabase } from './supabaseClient.js?v=9'

const resendInviteButton = document.getElementById('resendInviteButton')
const tableBody = document.getElementById('usersTableBody')
const usersMessage = document.getElementById('usersMessage')

function normalizeEmail(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : ''
}

function setMessage(text, type = '') {
  if (!usersMessage) return

  usersMessage.textContent = text
  usersMessage.className = type
    ? `um-message ${type}`
    : 'um-message'
}

function getSelectedRow() {
  if (!tableBody) return null

  return (
    tableBody.querySelector('tr.selected') ||
    tableBody.querySelector('.um-select:checked')?.closest('tr') ||
    null
  )
}

function getSelectedEmail() {
  const selectedRow = getSelectedRow()

  if (!selectedRow) return ''

  return normalizeEmail(selectedRow.cells?.[3]?.textContent)
}

function setLoading(loading) {
  if (!resendInviteButton) return

  resendInviteButton.dataset.loading = String(loading)
  resendInviteButton.textContent = loading
    ? 'Sending...'
    : 'Resend Invite'

  updateButtonState()
}

function updateButtonState() {
  if (!resendInviteButton) return

  const loading = resendInviteButton.dataset.loading === 'true'
  resendInviteButton.disabled = loading || !getSelectedEmail()
}

async function resendInvite() {
  const email = getSelectedEmail()

  if (!email) {
    updateButtonState()
    setMessage('Select a user before clicking Resend Invite.', 'error')
    return
  }

  setLoading(true)
  setMessage(`Sending a new invitation link to ${email}...`)

  try {
    const redirectTo = new URL(
      './change-password.html?invite=1',
      window.location.href
    ).href

    const { error } = await supabase.auth.resetPasswordForEmail(
      email,
      { redirectTo }
    )

    if (error) throw error

    setMessage(
      `A new invitation link was sent to ${email}. The user's account and permissions were not changed.`,
      'success'
    )
  } catch (error) {
    setMessage(
      `Unable to resend the invitation: ${error?.message || 'An unexpected error occurred.'}`,
      'error'
    )
  } finally {
    setLoading(false)
  }
}

if (resendInviteButton && tableBody) {
  resendInviteButton.dataset.loading = 'false'
  resendInviteButton.addEventListener('click', resendInvite)
  tableBody.addEventListener('change', updateButtonState)

  const observer = new MutationObserver(updateButtonState)
  observer.observe(tableBody, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  })

  updateButtonState()
}
