import { supabase } from './supabaseClient.js?v=12'
import { requireWorkforcePermission } from './workforce-permissions.js?v=1'

const elements = {
  count: document.getElementById('myV2PayslipCount'),
  finalizedCount: document.getElementById('myV2FinalizedCount'),
  latestPayment: document.getElementById('myV2LatestPayment'),
  latestNet: document.getElementById('myV2LatestNet'),
  refresh: document.getElementById('refreshMyV2PayslipsButton'),
  body: document.getElementById('myV2PayslipsTableBody'),
  message: document.getElementById('myV2PayslipsMessage')
}

let busy = false

function formatDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return '—'
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(date)
}

function formatMoney(value, currencyCode) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—'
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(Number(value))
  } catch {
    return `${Number(value).toFixed(2)} ${currencyCode || 'USD'}`
  }
}

function cell(text, className = '') {
  const td = document.createElement('td')
  td.textContent = text
  if (className) td.className = className
  return td
}

function setMessage(message, isError = false) {
  elements.message.textContent = message
  elements.message.classList.toggle('error', isError)
}

function availablePayslips(data) {
  if (!Array.isArray(data)) return []
  return data.filter(row =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(row?.payroll_v2_record_id || '')) &&
    (
      String(row.status || '').toLowerCase() === 'finalized' ||
      (String(row.status || '').toLowerCase() === 'approved' && row.recalculation_pending !== true)
    )
  )
}

function render(data) {
  const payslips = availablePayslips(data)
  const latest = payslips[0] || null
  elements.count.textContent = String(payslips.length)
  elements.finalizedCount.textContent = String(payslips.filter(row =>
    String(row.status).toLowerCase() === 'finalized'
  ).length)
  elements.latestPayment.textContent = latest ? formatDate(latest.payment_date) : '—'
  elements.latestNet.textContent = latest ? formatMoney(latest.net_pay, latest.currency_code) : '—'

  const rows = document.createDocumentFragment()
  for (const payslip of payslips) {
    const tr = document.createElement('tr')
    const period = cell(`${formatDate(payslip.period_start)} – ${formatDate(payslip.period_end)}`)
    const status = String(payslip.status).toLowerCase()
    const statusCell = document.createElement('td')
    const badge = document.createElement('span')
    badge.className = `my-payslips-v2-badge ${status}`
    badge.textContent = status === 'finalized' ? 'Finalized' : 'Approved'
    statusCell.append(badge)

    const actionCell = document.createElement('td')
    const actions = document.createElement('div')
    actions.className = 'my-payslips-actions'
    for (const [label, print] of [['View', false], ['Print / Save PDF', true]]) {
      const link = document.createElement('a')
      link.className = `my-payslips-action${print ? '' : ' primary'}`
      link.textContent = label
      const params = new URLSearchParams({ record: payslip.payroll_v2_record_id })
      if (print) params.set('print', '1')
      link.href = `./payslip-v2-preview.html?${params}`
      actions.append(link)
    }
    actionCell.append(actions)
    tr.append(
      period,
      cell(formatDate(payslip.payment_date)),
      statusCell,
      cell(formatMoney(payslip.gross_pay, payslip.currency_code), 'my-payslips-money'),
      cell(formatMoney(payslip.total_deductions, payslip.currency_code), 'my-payslips-money'),
      cell(formatMoney(payslip.net_pay, payslip.currency_code), 'my-payslips-money net'),
      actionCell
    )
    rows.append(tr)
  }

  if (!payslips.length) {
    const tr = document.createElement('tr')
    const td = cell('No approved or finalized Payroll V2 payslips are available for your account.', 'wf-empty')
    td.colSpan = 7
    tr.append(td)
    rows.append(tr)
  }
  elements.body.replaceChildren(rows)
  setMessage(payslips.length
    ? `${payslips.length} Payroll V2 ${payslips.length === 1 ? 'payslip' : 'payslips'} available.`
    : 'Your Payroll V2 payslips will appear here once approved and ready.')
}

async function loadPayslips() {
  if (busy) return
  busy = true
  elements.refresh.disabled = true
  setMessage('Loading your Payroll V2 payslips…')
  try {
    const { data, error } = await supabase.rpc('payroll_v2_list_my_payslips')
    if (error) throw error
    render(data)
  } catch (error) {
    render([])
    setMessage(error?.message || 'Unable to load your Payroll V2 payslips.', true)
  } finally {
    busy = false
    elements.refresh.disabled = false
  }
}

async function initialize() {
  try {
    const access = await requireWorkforcePermission(
      supabase,
      'view_own_payslips',
      {
        returnTo: 'my-payslips-v2.html',
        deniedPath: './home.html',
        deniedMessage: 'You do not have permission to view your payslips.'
      }
    )
    if (!access) return
    document.body.classList.remove('my-payslips-access-pending')
    await loadPayslips()
  } catch {
    document.body.classList.remove('my-payslips-access-pending')
    setMessage('Unable to open your payslips. Please sign in again or contact payroll.', true)
  }
}

elements.refresh.addEventListener('click', loadPayslips)
initialize()
