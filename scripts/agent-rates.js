import { supabase } from './supabaseClient.js?v=10'
import { requireWorkforcePermission } from './workforce-permissions.js?v=1'

const PAID_HOURS_PER_DAY = 8
const WORK_DAYS_PER_MONTH = 22
const PAID_HOURS_PER_MONTH = PAID_HOURS_PER_DAY * WORK_DAYS_PER_MONTH

const state = {
  employees: [],
  selectedEmployeeId: '',
  search: '',
  loading: false,
  accessToken: '',
  paypalQuote: null,
  paypalQuoteLoading: false,
  paypalQuoteError: ''
}

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4
})

const phpFormatter = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4
})

const dateFormatter = new Intl.DateTimeFormat('en-PH', {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
})

const dateTimeFormatter = new Intl.DateTimeFormat('en-PH', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

const pageMessage = document.getElementById('agentRatesPageMessage')
const formMessage = document.getElementById('agentRateFormMessage')
const employeeList = document.getElementById('rateEmployeeList')
const employeeSearch = document.getElementById('rateEmployeeSearch')
const employeeSelect = document.getElementById('rateEmployeeSelect')
const rateForm = document.getElementById('agentRateForm')
const saveButton = document.getElementById('saveAgentRateButton')
const refreshButton = document.getElementById('refreshAgentRatesButton')
const paypalFxPanel = document.getElementById('paypalFxPanel')
const paypalFxTitle = document.getElementById('paypalFxTitle')
const paypalFxMeta = document.getElementById('paypalFxMeta')
const refreshPaypalRateButton = document.getElementById('refreshPaypalRateButton')
const rateInputIds = [
  'hourlyRate',
  'dailyRate',
  'monthlyRate',
  'overtimeRate',
  'holidayRate'
]

function localToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
}

function formatDate(value) {
  if (!value) return '—'
  return dateFormatter.format(new Date(`${value}T00:00:00`))
}

function formatDateTime(value) {
  if (!value) return '—'
  return dateTimeFormatter.format(new Date(value))
}

function formatUsd(value) {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  return Number.isFinite(number) ? usdFormatter.format(number) : '—'
}

function phpConversion(value) {
  const number = Number(value)
  const exchangeRate = Number(state.paypalQuote?.exchangeRate)
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    !Number.isFinite(number) ||
    !Number.isFinite(exchangeRate) ||
    exchangeRate <= 0
  ) {
    return null
  }
  return number * exchangeRate
}

function formatPhpConversion(value) {
  const converted = phpConversion(value)
  return converted === null ? 'PHP: —' : `PHP: ≈ ${phpFormatter.format(converted)}`
}

function initials(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return (parts.slice(0, 2).map(part => part[0]).join('') || 'AG').toUpperCase()
}

function setMessage(element, message = '', type = '') {
  element.textContent = message
  element.classList.toggle('error', type === 'error')
  element.classList.toggle('success', type === 'success')
}

function element(tag, className = '', text = '') {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

function currentRate(employee) {
  const today = localToday()
  return employee.rates.find(rate => rate.effective_date <= today) || null
}

function hasFutureRate(employee) {
  const today = localToday()
  return employee.rates.some(rate => rate.effective_date > today)
}

function groupDirectoryRows(rows) {
  const employees = new Map()

  for (const row of rows || []) {
    let employee = employees.get(row.employee_user_id)

    if (!employee) {
      employee = {
        id: row.employee_user_id,
        name: row.employee_name || row.employee_email || 'Unnamed agent',
        number: row.employee_number || '',
        email: row.employee_email || '',
        employmentStatus: row.employment_status || '',
        rates: []
      }
      employees.set(employee.id, employee)
    }

    if (row.rate_id) {
      employee.rates.push({
        id: row.rate_id,
        effective_date: row.effective_date,
        currency_code: row.currency_code,
        hourly_rate: row.hourly_rate,
        daily_rate: row.daily_rate,
        monthly_rate: row.monthly_rate,
        overtime_rate: row.overtime_rate,
        holiday_rate: row.holiday_rate,
        rate_change_reason: row.rate_change_reason,
        created_by: row.created_by,
        created_at: row.created_at
      })
    }
  }

  return [...employees.values()]
}

function selectedEmployee() {
  return state.employees.find(employee => employee.id === state.selectedEmployeeId) || null
}

function renderSummary() {
  const currentCount = state.employees.filter(currentRate).length
  const futureCount = state.employees.reduce(
    (total, employee) =>
      total + employee.rates.filter(rate => rate.effective_date > localToday()).length,
    0
  )

  document.getElementById('rateEmployeeCount').textContent = state.employees.length
  document.getElementById('rateCurrentCount').textContent = currentCount
  document.getElementById('rateMissingCount').textContent =
    state.employees.length - currentCount
  document.getElementById('rateFutureCount').textContent = futureCount
}

function renderEmployeeSelect() {
  const fragment = document.createDocumentFragment()
  const placeholder = element('option', '', 'Select an eligible employee')
  placeholder.value = ''
  fragment.append(placeholder)

  for (const employee of state.employees) {
    const option = element(
      'option',
      '',
      `${employee.name}${employee.number ? ` · ${employee.number}` : ''}`
    )
    option.value = employee.id
    fragment.append(option)
  }

  employeeSelect.replaceChildren(fragment)
  employeeSelect.value = state.selectedEmployeeId
}

function renderEmployeeList() {
  const query = state.search.trim().toLowerCase()
  const filtered = state.employees.filter(employee =>
    !query ||
    [employee.name, employee.number, employee.email]
      .some(value => String(value || '').toLowerCase().includes(query))
  )

  document.getElementById('rateDirectoryCount').textContent = filtered.length

  if (!filtered.length) {
    employeeList.replaceChildren(
      element('p', 'rate-directory-empty', 'No eligible employees match your search.')
    )
    return
  }

  const fragment = document.createDocumentFragment()

  for (const employee of filtered) {
    const button = element('button', 'rate-employee-button')
    button.type = 'button'
    button.dataset.employeeId = employee.id
    button.setAttribute('role', 'option')
    button.setAttribute(
      'aria-selected',
      String(employee.id === state.selectedEmployeeId)
    )

    const avatar = element('span', 'rate-avatar', initials(employee.name))
    avatar.setAttribute('aria-hidden', 'true')

    const copy = element('span', 'rate-employee-copy')
    copy.append(
      element('strong', '', employee.name),
      element('small', '', employee.number || employee.email || 'Agent')
    )

    const dot = element('span', 'rate-status-dot')
    const activeRate = currentRate(employee)
    if (!activeRate) dot.classList.add(hasFutureRate(employee) ? 'future' : 'missing')
    dot.title = activeRate
      ? 'Current rate available'
      : hasFutureRate(employee)
        ? 'Future rate only'
        : 'Missing current rate'

    button.append(avatar, copy, dot)
    fragment.append(button)
  }

  employeeList.replaceChildren(fragment)
}

function rateValue(label, value) {
  const card = element('article')
  card.append(
    element('span', '', label),
    element('strong', '', formatUsd(value)),
    element('small', 'rate-php-row', formatPhpConversion(value))
  )
  return card
}

function appendRateLine(container, label, value) {
  const line = element('span', 'rate-line')
  line.append(
    element('em', '', `${label}: `),
    document.createTextNode(formatUsd(value)),
    element('small', 'rate-line-php', formatPhpConversion(value))
  )
  container.append(line)
}

function renderRateInputPreviews() {
  for (const inputId of rateInputIds) {
    const input = document.getElementById(inputId)
    const preview = document.querySelector(`[data-php-preview-for="${inputId}"]`)
    preview.textContent = formatPhpConversion(input.value)
  }
}

function formatCalculatedRate(value) {
  return Number(value.toFixed(4)).toString()
}

function updateCalculatedBaseRates() {
  const hourlyInput = document.getElementById('hourlyRate')
  const dailyInput = document.getElementById('dailyRate')
  const monthlyInput = document.getElementById('monthlyRate')
  const hourlyRate = Number(hourlyInput.value)

  if (
    hourlyInput.value.trim() === '' ||
    !Number.isFinite(hourlyRate) ||
    hourlyRate < 0
  ) {
    dailyInput.value = ''
    monthlyInput.value = ''
  } else {
    dailyInput.value = formatCalculatedRate(
      hourlyRate * PAID_HOURS_PER_DAY
    )
    monthlyInput.value = formatCalculatedRate(
      hourlyRate * PAID_HOURS_PER_MONTH
    )
  }

  renderRateInputPreviews()
}

function renderPaypalQuote() {
  const quote = state.paypalQuote
  const isEstimate = quote?.rateType === 'paypal_estimate'
  paypalFxPanel.classList.toggle('loading', state.paypalQuoteLoading)
  paypalFxPanel.classList.toggle('available', Boolean(quote))
  paypalFxPanel.classList.toggle('estimated', isEstimate)
  paypalFxPanel.classList.toggle('unavailable', !quote)
  refreshPaypalRateButton.disabled = state.paypalQuoteLoading

  if (state.paypalQuoteLoading) {
    paypalFxTitle.textContent = 'Checking PayPal USD to PHP rate…'
    paypalFxMeta.textContent = 'The quote is requested securely from the server.'
  } else if (quote) {
    paypalFxTitle.textContent =
      `1 USD ${isEstimate ? '≈' : '='} ${phpFormatter.format(quote.exchangeRate)}`

    if (isEstimate) {
      paypalFxMeta.textContent =
        `Estimated PayPal payout conversion · ECB reference ${phpFormatter.format(quote.marketRate)} on ${formatDate(quote.referenceDate)}, reduced by PayPal's published ${quote.spreadPercent}% payment/Payouts spread. PHP values are display-only.`
    } else {
      const timing = quote.expiresAt
        ? ` · Expires ${formatDateTime(quote.expiresAt)}`
        : ''
      paypalFxMeta.textContent =
        `Live PayPal quote · Retrieved ${formatDateTime(quote.fetchedAt)}${timing}. PHP values are display-only.`
    }
  } else {
    paypalFxTitle.textContent = 'PHP conversion unavailable'
    paypalFxMeta.textContent =
      state.paypalQuoteError ||
      'A live PayPal USD to PHP quote is not currently available.'
  }

  renderRateInputPreviews()
}

async function loadPaypalQuote() {
  if (state.paypalQuoteLoading || !state.accessToken) return
  state.paypalQuoteLoading = true
  state.paypalQuoteError = ''
  renderPaypalQuote()

  try {
    const response = await fetch('./api/paypal-exchange-rate', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${state.accessToken}`
      },
      cache: 'no-store'
    })
    const result = await response.json().catch(() => null)

    if (!response.ok || !Number.isFinite(Number(result?.exchangeRate))) {
      state.paypalQuote = null
      state.paypalQuoteError =
        result?.error || 'The live PayPal rate could not be loaded.'
    } else {
      state.paypalQuote = {
        source: result.source,
        rateType: result.rateType,
        exchangeRate: Number(result.exchangeRate),
        marketRate: Number(result.marketRate),
        spreadPercent: Number(result.spreadPercent),
        referenceSource: result.referenceSource,
        referenceProvider: result.referenceProvider,
        referenceDate: result.referenceDate,
        fetchedAt: result.fetchedAt,
        expiresAt: result.expiresAt,
        refreshesAt: result.refreshesAt
      }
    }
  } catch {
    state.paypalQuote = null
    state.paypalQuoteError = 'The live PayPal rate could not be loaded.'
  } finally {
    state.paypalQuoteLoading = false
    renderPaypalQuote()
    renderSelectedEmployee()
  }
}

function renderHistory(employee) {
  const body = document.getElementById('rateHistoryBody')
  const historyCount = document.getElementById('rateHistoryCount')

  if (!employee) {
    const row = document.createElement('tr')
    const cell = element('td', 'wf-empty', 'Select an employee to view rate history.')
    cell.colSpan = 5
    row.append(cell)
    body.replaceChildren(row)
    historyCount.textContent = '0 records'
    return
  }

  historyCount.textContent =
    `${employee.rates.length} ${employee.rates.length === 1 ? 'record' : 'records'}`

  if (!employee.rates.length) {
    const row = document.createElement('tr')
    const cell = element('td', 'wf-empty', 'No rate history has been recorded.')
    cell.colSpan = 5
    row.append(cell)
    body.replaceChildren(row)
    return
  }

  const today = localToday()
  const active = currentRate(employee)
  const fragment = document.createDocumentFragment()

  for (const rate of employee.rates) {
    const row = document.createElement('tr')
    const effectiveCell = element('td', 'rate-history-effective')
    effectiveCell.append(element('strong', '', formatDate(rate.effective_date)))

    const status = rate.effective_date > today
      ? element('small', '', 'Future')
      : rate.id === active?.id
        ? element('small', '', 'Current')
        : element('small', '', 'Historical')
    effectiveCell.append(status)

    const baseCell = document.createElement('td')
    appendRateLine(baseCell, 'Hourly', rate.hourly_rate)
    appendRateLine(baseCell, 'Daily', rate.daily_rate)
    appendRateLine(baseCell, 'Monthly', rate.monthly_rate)

    const premiumCell = document.createElement('td')
    appendRateLine(premiumCell, 'Overtime', rate.overtime_rate)
    appendRateLine(premiumCell, 'Holiday', rate.holiday_rate)

    const reasonCell = element(
      'td',
      'rate-history-reason',
      rate.rate_change_reason || '—'
    )

    const recordedCell = document.createElement('td')
    recordedCell.append(
      element('strong', '', formatDateTime(rate.created_at)),
      element('small', '', 'Immutable audit record')
    )

    row.append(effectiveCell, baseCell, premiumCell, reasonCell, recordedCell)
    fragment.append(row)
  }

  body.replaceChildren(fragment)
}

function renderSelectedEmployee() {
  const employee = selectedEmployee()
  const selectedName = document.getElementById('selectedAgentName')
  const selectedMeta = document.getElementById('selectedAgentMeta')
  const selectedAvatar = document.getElementById('selectedAgentAvatar')
  const status = document.getElementById('selectedRateStatus')
  const values = document.getElementById('currentRateValues')
  const effective = document.getElementById('currentRateEffective')

  employeeSelect.value = employee?.id || ''

  if (!employee) {
    selectedName.textContent = 'Select an employee'
    selectedMeta.textContent = 'Choose an eligible agent from the directory.'
    selectedAvatar.textContent = '—'
    status.textContent = 'No selection'
    status.className = 'wf-badge muted'
    values.replaceChildren(
      rateValue('Hourly', null),
      rateValue('Daily', null),
      rateValue('Monthly', null),
      rateValue('Overtime', null),
      rateValue('Holiday', null)
    )
    effective.textContent = 'No current rate on file.'
    renderHistory(null)
    return
  }

  selectedName.textContent = employee.name
  selectedMeta.textContent =
    [employee.number, employee.email].filter(Boolean).join(' · ') || 'Eligible agent'
  selectedAvatar.textContent = initials(employee.name)

  const activeRate = currentRate(employee)
  status.textContent = activeRate
    ? 'Current rate'
    : hasFutureRate(employee)
      ? 'Future rate only'
      : 'Missing rate'
  status.className = activeRate
    ? 'wf-badge success'
    : hasFutureRate(employee)
      ? 'wf-badge warning'
      : 'wf-badge danger'

  values.replaceChildren(
    rateValue('Hourly', activeRate?.hourly_rate),
    rateValue('Daily', activeRate?.daily_rate),
    rateValue('Monthly', activeRate?.monthly_rate),
    rateValue('Overtime', activeRate?.overtime_rate),
    rateValue('Holiday', activeRate?.holiday_rate)
  )
  effective.textContent = activeRate
    ? `Effective ${formatDate(activeRate.effective_date)} · ${activeRate.rate_change_reason}`
    : hasFutureRate(employee)
      ? 'No current rate. A future-dated change is on file.'
      : 'No current rate on file.'

  renderHistory(employee)
}

function renderAll() {
  renderSummary()
  renderEmployeeSelect()
  renderEmployeeList()
  renderSelectedEmployee()
  renderPaypalQuote()
}

async function loadDirectory({ preserveSelection = true } = {}) {
  if (state.loading) return
  state.loading = true
  refreshButton.disabled = true
  setMessage(pageMessage, 'Loading authorized rate records…')

  const previousSelection = preserveSelection ? state.selectedEmployeeId : ''
  const { data, error } = await supabase.rpc('payroll_get_agent_rate_directory')

  state.loading = false
  refreshButton.disabled = false

  if (error) {
    setMessage(
      pageMessage,
      'Rate records could not be loaded. Please refresh or contact a system administrator.',
      'error'
    )
    return
  }

  state.employees = groupDirectoryRows(data)
  state.selectedEmployeeId = state.employees.some(
    employee => employee.id === previousSelection
  )
    ? previousSelection
    : state.employees[0]?.id || ''

  renderAll()
  setMessage(
    pageMessage,
    state.employees.length
      ? ''
      : 'No active or on-leave agents are available for rate management.'
  )
}

function parseOptionalRate(inputId) {
  const value = document.getElementById(inputId).value.trim()
  return value === '' ? null : Number(value)
}

function validateRatePayload(payload) {
  if (!payload.p_employee_id) return 'Select an employee.'
  if (!payload.p_effective_date) return 'Select an effective date.'
  if (!payload.p_rate_change_reason) return 'Enter a rate-change reason.'

  if (payload.p_hourly_rate === null) {
    return 'Enter an hourly rate.'
  }

  const allRates = [
    payload.p_hourly_rate,
    payload.p_daily_rate,
    payload.p_monthly_rate,
    payload.p_overtime_rate,
    payload.p_holiday_rate
  ]

  if (allRates.some(value => value !== null && (!Number.isFinite(value) || value < 0))) {
    return 'Rates must be valid non-negative numbers.'
  }

  return ''
}

function resetRateInputs() {
  for (const id of [...rateInputIds, 'rateChangeReason']) {
    document.getElementById(id).value = ''
  }
  renderRateInputPreviews()
}

async function submitRate(event) {
  event.preventDefault()

  const payload = {
    p_employee_id: employeeSelect.value,
    p_effective_date: document.getElementById('rateEffectiveDate').value,
    p_rate_change_reason: document.getElementById('rateChangeReason').value.trim(),
    p_hourly_rate: parseOptionalRate('hourlyRate'),
    p_daily_rate: parseOptionalRate('dailyRate'),
    p_monthly_rate: parseOptionalRate('monthlyRate'),
    p_overtime_rate: parseOptionalRate('overtimeRate'),
    p_holiday_rate: parseOptionalRate('holidayRate')
  }

  const validationMessage = validateRatePayload(payload)
  if (validationMessage) {
    setMessage(formMessage, validationMessage, 'error')
    return
  }

  saveButton.disabled = true
  setMessage(formMessage, 'Saving the new immutable rate record…')

  const { error } = await supabase.rpc('payroll_create_agent_rate', payload)

  saveButton.disabled = false

  if (error) {
    const safeMessage = String(error.message || '')
    const knownMessage = [
      'A rate already exists',
      'Rates can only be added',
      'Enter at least one base rate',
      'Rate-change reason',
      'Rates cannot be negative',
      'Effective date is required'
    ].find(message => safeMessage.includes(message))

    setMessage(
      formMessage,
      knownMessage ? safeMessage : 'The new rate could not be saved. Please review the values and try again.',
      'error'
    )
    return
  }

  state.selectedEmployeeId = payload.p_employee_id
  resetRateInputs()
  setMessage(formMessage, 'Rate saved. The historical record is now immutable.', 'success')
  await loadDirectory()
}

function selectEmployee(employeeId) {
  if (!state.employees.some(employee => employee.id === employeeId)) return
  state.selectedEmployeeId = employeeId
  renderEmployeeList()
  renderSelectedEmployee()
  setMessage(formMessage)
}

employeeList.addEventListener('click', event => {
  const button = event.target.closest('[data-employee-id]')
  if (button) selectEmployee(button.dataset.employeeId)
})

employeeSearch.addEventListener('input', () => {
  state.search = employeeSearch.value
  renderEmployeeList()
})

employeeSelect.addEventListener('change', () => {
  selectEmployee(employeeSelect.value)
})

refreshButton.addEventListener('click', async () => {
  await Promise.all([loadDirectory(), loadPaypalQuote()])
})
refreshPaypalRateButton.addEventListener('click', loadPaypalQuote)
rateForm.addEventListener('submit', submitRate)
for (const inputId of rateInputIds) {
  document.getElementById(inputId).addEventListener('input', renderRateInputPreviews)
}
document.getElementById('hourlyRate').addEventListener(
  'input',
  updateCalculatedBaseRates
)
document.getElementById('rateEffectiveDate').value = localToday()

async function initializeAgentRates() {
  try {
    const access = await requireWorkforcePermission(
      supabase,
      'manage_agent_rates',
      {
        returnTo: './agent-rates.html',
        deniedPath: './home.html',
        deniedMessage: 'Payroll rate access is required to open Agent Rates.'
      }
    )

    if (!access) return
    state.accessToken = access.session?.access_token || ''
    document.body.classList.remove('rate-access-pending')
    await Promise.all([
      loadDirectory({ preserveSelection: false }),
      loadPaypalQuote()
    ])
  } catch {
    document.body.classList.remove('rate-access-pending')
    setMessage(
      pageMessage,
      'Agent Rates could not be initialized. Please sign in again or contact a system administrator.',
      'error'
    )
  }
}

initializeAgentRates()
