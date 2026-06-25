import { supabase } from './supabaseClient.js?v=8'
import {
  requiresFirstLoginPasswordChange
} from './first-login-policy.js?v=4'
import { loadAgentDetail } from './data-details-agent.js?v=2'
import { loadDistributionDetail } from './data-details-distribution.js?v=2'
import { loadDriverDetail } from './data-details-driver.js?v=2'
import {
  getDetailElements,
  renderModel,
  showError
} from './data-details-render.js?v=3'
import {
  isIsoDate,
  normalizeKey,
  parseDateRangeRequest
} from './data-details-utils.js?v=2'

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

  return {
    view,
    key,
    rangeRequest: parseDateRangeRequest(params)
  }
}

function initializeDateFilter(elements, request) {
  const { rangeRequest } = request
  elements.rangeSelect.value = rangeRequest.mode
  elements.startDate.value = rangeRequest.start
  elements.endDate.value = rangeRequest.end

  const toggleCustomFields = () => {
    const isCustom = elements.rangeSelect.value === 'custom'
    elements.customRangeFields.hidden = !isCustom
    elements.startDate.required = isCustom
    elements.endDate.required = isCustom
    elements.filterValidation.textContent = ''
  }

  toggleCustomFields()
  elements.rangeSelect.addEventListener('change', toggleCustomFields)

  elements.filterForm.addEventListener('submit', event => {
    event.preventDefault()
    const mode = elements.rangeSelect.value
    const start = elements.startDate.value
    const end = elements.endDate.value

    if (mode === 'custom') {
      if (!isIsoDate(start) || !isIsoDate(end)) {
        elements.filterValidation.textContent =
          'Choose both a valid start date and end date.'
        ;(!isIsoDate(start) ? elements.startDate : elements.endDate).focus()
        return
      }

      if (start > end) {
        elements.filterValidation.textContent =
          'The start date cannot be after the end date.'
        elements.startDate.focus()
        return
      }
    }

    elements.filterValidation.textContent = ''
    elements.filterButton.disabled = true
    elements.filterButton.textContent = 'Applying...'

    const url = new URL(window.location.href)
    url.searchParams.set('range', mode)

    if (mode === 'custom') {
      url.searchParams.set('start', start)
      url.searchParams.set('end', end)
    } else {
      url.searchParams.delete('start')
      url.searchParams.delete('end')
    }

    window.location.assign(url.toString())
  })
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
    initializeDateFilter(elements, request)

    const user = await requireApprovedUser()
    if (!user) return

    let model

    if (request.view === 'driver') {
      model = await loadDriverDetail(request.key, request.rangeRequest)
    } else if (request.view === 'agent') {
      model = await loadAgentDetail(request.key, request.rangeRequest)
    } else {
      model = await loadDistributionDetail(
        request.view,
        request.key,
        request.rangeRequest
      )
    }

    renderModel(elements, model)
  } catch (error) {
    showError(elements, error)
  }
}

initialize()
