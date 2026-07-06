import {
  requireApprovedUser,
  supabase
} from './sheet-reporting.js?v=1'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

function showAccessError(message) {
  const page = document.getElementById('operationsPage')
  const status = document.getElementById('operationsStatus')
  const content = document.getElementById('operationsContent')

  if (page) {
    page.setAttribute('aria-busy', 'false')
  }

  if (content) {
    content.hidden = true
  }

  if (!status) return

  status.hidden = false
  status.replaceChildren()

  const heading = document.createElement('h2')
  heading.textContent = 'Reporting Operations unavailable'

  const paragraph = document.createElement('p')
  paragraph.textContent = message

  status.append(heading, paragraph)
}

async function initializeReportingOperationsEntry() {
  try {
    const user = await requireApprovedUser()

    if (!user) return

    const access = await loadCurrentWorkforceAccess(supabase)
    const canAccessOperations =
      access.allowed === true &&
      access.is_admin === true &&
      hasWorkforcePermission(access, 'view_workforce_reports')

    if (!canAccessOperations) {
      const message =
        'Reporting Operations is available only to authorized administrators.'

      showAccessError(message)
      window.alert(message)
      window.location.replace('./dashboard.html')
      return
    }

    await import('./reporting-operations.js?v=1')
  } catch (error) {
    console.error('Unable to verify Reporting Operations access:', error)
    showAccessError(
      'Administrator access could not be verified. Return to the dashboard and try again.'
    )
  }
}

initializeReportingOperationsEntry()
