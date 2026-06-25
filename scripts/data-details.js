import { supabase } from './supabaseClient.js?v=8'
import {
  requiresFirstLoginPasswordChange
} from './first-login-policy.js?v=4'
import { loadAgentDetail } from './data-details-agent.js?v=1'
import { loadDistributionDetail } from './data-details-distribution.js?v=1'
import { loadDriverDetail } from './data-details-driver.js?v=1'
import {
  getDetailElements,
  renderModel,
  showError
} from './data-details-render.js?v=2'
import { normalizeKey } from './data-details-utils.js?v=1'

const VALID_VIEWS = new Set([
  'driver',
  'agent',
  'app',
  'platform',
  'country'
])

function getDetailRequest() {
  const params = new URLSearchParams(window.location.search)
  const view = normalizeKey(params.get('view'))

  if (!VALID_VIEWS.has(view)) {
    throw new Error(
      'This detail link is missing a supported view. Return to the dashboard and open a chart again.'
    )
  }

  const parameterName = view === 'driver'
    ? 'group'
    : view === 'agent'
      ? 'agent'
      : 'value'
  const key = normalizeKey(params.get(parameterName))

  if (!key) {
    throw new Error(
      `This ${view} detail link is missing a valid ${parameterName} value.`
    )
  }

  return { view, key }
}

async function requireApprovedUser() {
  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser()

  if (userError) throw userError

  if (!user) {
    window.location.replace('./login.html')
    return null
  }

  let currentUser = user

  if (requiresFirstLoginPasswordChange(currentUser)) {
    const {
      data: { session },
      error: refreshError
    } = await supabase.auth.refreshSession()

    if (!refreshError && session?.user) {
      currentUser = session.user
    }

    if (requiresFirstLoginPasswordChange(currentUser)) {
      window.location.replace('./change-password.html?firstLogin=1')
      return null
    }
  }

  const email = currentUser.email?.trim().toLowerCase()

  if (!email) {
    await supabase.auth.signOut()
    window.location.replace('./login.html')
    return null
  }

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

async function initialize() {
  const elements = getDetailElements()

  elements.logout.addEventListener('click', async event => {
    event.preventDefault()
    await supabase.auth.signOut()
    window.location.href = './login.html'
  })

  try {
    const request = getDetailRequest()
    const user = await requireApprovedUser()
    if (!user) return

    let model

    if (request.view === 'driver') {
      model = await loadDriverDetail(request.key)
    } else if (request.view === 'agent') {
      model = await loadAgentDetail(request.key)
    } else {
      model = await loadDistributionDetail(request.view, request.key)
    }

    renderModel(elements, model)
  } catch (error) {
    showError(elements, error)
  }
}

initialize()
