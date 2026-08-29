import { supabase } from './supabaseClient.js?v=11'
import { requireWorkforcePermission } from './workforce-permissions.js?v=1'

const PAID_HOURS_PER_DAY = 8
const WORK_DAYS_PER_MONTH = 22
const PAID_HOURS_PER_MONTH = PAID_HOURS_PER_DAY * WORK_DAYS_PER_MONTH
const pageParams = new URLSearchParams(window.location.search)
const requestedEmployeeId = pageParams.get('employee') || ''
const requestedEffectiveDate = pageParams.get('effectiveDate') || ''

const state = {
  employees: [],
  selectedEmployeeId: '',
  search: '',
  loading: false,
  paypalConversionRate: null,
  paypalConversionUpdatedAt: null,
  paypalConversionUpdatedByName: '',
  paypalConversionLoading: false,
  paypalConversionError: '',
  canEditPaypalConversion: false
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
const paypalFxHelper = document.getElementById('paypalFxHelper')
const paypalFxMeta = document.getElementById('paypalFxMeta')
const paypalConversionForm = document.getElementById('paypalConversionForm')
const paypalConversionInput = document.getElementById('paypalConversionRate')
const applyPaypalRateButton = document.getElementById('applyPaypalRateButton')
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
  const conversionRate = Number(state.paypalConversionRate)
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    !Number.isFinite(number) ||
    !Number.isFinite(conversionRate) ||
    conversionRate <= 0
  ) {
    return null
  }
  return number * conversionRate
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

function renderPaypalConversion() {
  const rate = Number(state.paypalConversionRate)
  const hasRate = Number.isFinite(rate) && rate > 0
  paypalFxPanel.classList.toggle('loading', state.paypalConversionLoading)
  paypalFxPanel.classList.toggle('available', hasRate)
  paypalFxPanel.classList.toggle('estimated', false)
  paypalFxPanel.classList.toggle('unavailable', !hasRate)
  const canEdit = state.canEditPaypalConversion
  paypalFxHelper.hidden = state.paypalConversionLoading
  paypalConversionInput.disabled = !canEdit || state.paypalConversionLoading
  applyPaypalRateButton.disabled = !canEdit || state.paypalConversionLoading

  if (state.paypalConversionLoading) {
    paypalFxTitle.textContent = 'Loading manual PayPal conversion'
    paypalFxMeta.textContent = 'Reading the saved admin rate…'
  } else if (hasRate) {
    paypalFxTitle.textContent = `1 USD = ${phpFormatter.format(rate)}`
    const updatedBy = state.paypalConversionUpdatedByName || 'authorized admin'
    paypalFxMeta.textContent = state.paypalConversionUpdatedAt
      ? `Last updated ${formatDateTime(state.paypalConversionUpdatedAt)} by ${updatedBy}. PHP amounts are display-only.`
      : `Saved by ${updatedBy}. PHP amounts are display-only.`
  } else {
    paypalFxTitle.textContent = 'No manual rate set'
    paypalFxMeta.textContent = state.paypalConversionError
  }

  if (!canEdit) {
    paypalFxMeta.textContent += ' Only payroll-authorized admins can change this rate.'
  }

  if (document.activeElement !== paypalConversionInput) {
    paypalConversionInput.value = hasRate ? String(rate) : ''
  }
  renderRateInputPreviews()
}

async function loadPaypalConversion() {
  if (state.paypalConversionLoading) return
  state.paypalConversionLoading = true
  state.paypalConversionError = ''
  renderPaypalConversion()

  try {
    const { data, error } = await supabase.rpc('payroll_get_paypal_conversion_rate')
    if (error) throw error
    const row = Array.isArray(data) ? data[0] : data
    const rate = Number(row?.usd_to_php_rate)
    if (!Number.isFinite(rate) || rate <= 0) {
      state.paypalConversionRate = null
      state.paypalConversionUpdatedAt = null
      state.paypalConversionUpdatedByName = ''
    } else {
      state.paypalConversionRate = rate
      state.paypalConversionUpdatedAt = row.updated_at || null
      state.paypalConversionUpdatedByName = row.updated_by_name || ''
    }
  } catch {
    state.paypalConversionError =
      'The saved PayPal conversion rate could not be loaded.'
  } finally {
    state.paypalConversionLoading = false
    renderPaypalConversion()
    renderSelectedEmployee()
  }
}

function renderHistory(employee) {
  const list = document.getElementById('rateHistoryBody')
  const historyCount = document.getElementById('rateHistoryCount')

  if (!employee) {
    list.replaceChildren(
      element('p', 'rate-history-empty', 'Select an employee to view rate history.')
    )
    historyCount.textContent = '0 records'
    return
  }

  historyCount.textContent =
    `${employee.rates.length} ${employee.rates.length === 1 ? 'record' : 'records'}`

  if (!employee.rates.length) {
    list.replaceChildren(
      element('p', 'rate-history-empty', 'No rate history has been recorded.')
    )
    return
  }

  const today = localToday()
  const active = currentRate(employee)
  const chronological = [...employee.rates].sort((left, right) =>
    left.effective_date.localeCompare(right.effective_date)
  )
  const displayRates = [...chronological].reverse()
  const fragment = document.createDocumentFragment()

  for (const rate of displayRates) {
    const row = element('article', 'rate-history-row')
    const rowInner = element('div', 'rate-history-row-inner')
    const dateColumn = element('div', 'rate-history-date')
    dateColumn.append(element('strong', '', formatDate(rate.effective_date)))

    const status = rate.effective_date > today
      ? element('span', 'rate-history-status future', 'Upcoming')
      : rate.id === active?.id
        ? element('span', 'rate-history-status current', 'Current')
        : element('span', 'rate-history-status historical', 'Superseded')
    dateColumn.append(status)

    const rateColumn = element('div', 'rate-history-rates')
    const hourlyRow = element('div', 'rate-history-hourly')
    hourlyRow.append(
      element('strong', '', `${formatUsd(rate.hourly_rate)}/hr`)
    )

    const chronologicalIndex = chronological.findIndex(item => item.id === rate.id)
    const previousRate = chronological[chronologicalIndex - 1]
    const delta = previousRate
      ? Number(rate.hourly_rate) - Number(previousRate.hourly_rate)
      : 0
    if (Number.isFinite(delta) && Math.abs(delta) >= 0.0001) {
      const deltaText = `${delta > 0 ? '+' : ''}${delta.toFixed(4)}`
      const deltaNode = element('span', 'rate-history-delta', deltaText)
      if (delta < 0) deltaNode.classList.add('negative')
      hourlyRow.append(deltaNode)
    }
    hourlyRow.append(
      element('small', 'rate-history-php', formatPhpConversion(rate.hourly_rate))
    )

    rateColumn.append(
      hourlyRow,
      element(
        'p',
        'rate-history-sub',
        `Daily ${formatUsd(rate.daily_rate)} (${formatPhpConversion(rate.daily_rate)}) · Monthly ${formatUsd(rate.monthly_rate)} (${formatPhpConversion(rate.monthly_rate)})`
      ),
      element(
        'p',
        'rate-history-sub',
        `Overtime ${formatUsd(rate.overtime_rate)} · Holiday ${formatUsd(rate.holiday_rate)}`
      )
    )

    const metaColumn = element('div', 'rate-history-meta')
    metaColumn.append(
      element('p', '', rate.rate_change_reason || '—'),
      element('small', '', `Recorded ${formatDateTime(rate.created_at)} · Immutable audit record`)
    )

    rowInner.append(dateColumn, rateColumn, metaColumn)
    row.append(rowInner)
    fragment.append(row)
  }

  list.replaceChildren(fragment)
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
  renderPaypalConversion()
}

async function loadDirectory({ preserveSelection = true } = {}) {
  if (state.loading) return
  state.loading = true
  refreshButton.disabled = true
  setMessage(pageMessage, 'Loading authorized rate records…')

  const previousSelection = preserveSelection
    ? state.selectedEmployeeId
    : requestedEmployeeId
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

function parsePaypalConversionRate() {
  const value = paypalConversionInput.value.trim()
  if (value === '') return { error: 'Enter a PayPal conversion rate.' }

  const rate = Number(value)
  if (!Number.isFinite(rate) || rate <= 0) {
    return { error: 'Enter a valid positive decimal rate.' }
  }

  return { rate }
}

async function applyPaypalConversion(event) {
  event.preventDefault()

  if (!state.canEditPaypalConversion) {
    setMessage(
      pageMessage,
      'Only payroll-authorized admins can change the PayPal conversion rate.',
      'error'
    )
    return
  }

  const parsed = parsePaypalConversionRate()
  if (parsed.error) {
    setMessage(pageMessage, parsed.error, 'error')
    return
  }

  applyPaypalRateButton.disabled = true
  setMessage(pageMessage, 'Saving the PayPal display conversion rate…')

  try {
    const { data, error } = await supabase.rpc(
      'payroll_set_paypal_conversion_rate',
      { p_usd_to_php_rate: parsed.rate }
    )
    if (error) throw error

    const row = Array.isArray(data) ? data[0] : data
    state.paypalConversionRate = Number(row.usd_to_php_rate)
    state.paypalConversionUpdatedAt = row.updated_at || null
    state.paypalConversionUpdatedByName = row.updated_by_name || ''
    state.paypalConversionError = ''
    renderPaypalConversion()
    renderSelectedEmployee()
    setMessage(pageMessage, 'PayPal display conversion rate applied.', 'success')
  } catch (error) {
    const safeMessage = String(error?.message || '')
    const knownMessage = [
      'You do not have permission',
      'conversion rate must be positive',
      'valid positive decimal'
    ].find(message => safeMessage.toLowerCase().includes(message.toLowerCase()))
    setMessage(
      pageMessage,
      knownMessage ? safeMessage : 'The PayPal conversion rate could not be saved.',
      'error'
    )
  } finally {
    applyPaypalRateButton.disabled = !state.canEditPaypalConversion || state.paypalConversionLoading
  }
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
  await Promise.all([loadDirectory(), loadPaypalConversion()])
})
paypalConversionForm.addEventListener('submit', applyPaypalConversion)
rateForm.addEventListener('submit', submitRate)
for (const inputId of rateInputIds) {
  document.getElementById(inputId).addEventListener('input', renderRateInputPreviews)
}
document.getElementById('hourlyRate').addEventListener(
  'input',
  updateCalculatedBaseRates
)
document.getElementById('rateEffectiveDate').value =
  /^\d{4}-\d{2}-\d{2}$/.test(requestedEffectiveDate)
    ? requestedEffectiveDate
    : localToday()

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
    state.canEditPaypalConversion = access.is_admin === true
    document.body.classList.remove('rate-access-pending')
    await Promise.all([
      loadDirectory({ preserveSelection: false }),
      loadPaypalConversion()
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
