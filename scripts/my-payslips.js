import { supabase } from './supabaseClient.js?v=10'
import { requireWorkforcePermission } from './workforce-permissions.js?v=1'

const elements = {
  count: document.getElementById('myPayslipCount'),
  latestPayment: document.getElementById('myPayslipLatestPayment'),
  latestNet: document.getElementById('myPayslipLatestNet'),
  pdfCount: document.getElementById('myPayslipPdfCount'),
  refresh: document.getElementById('refreshMyPayslipsButton'),
  body: document.getElementById('myPayslipsTableBody'),
  message: document.getElementById('myPayslipsMessage')
}

const state = {
  accessToken: '',
  payslips: [],
  busy: false
}

const dateFormatter = new Intl.DateTimeFormat('en-PH', {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
})

function formatDate(value) {
  if (!value) return '—'
  return dateFormatter.format(new Date(`${value}T00:00:00`))
}

function formatDateTime(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-PH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Manila'
  }).format(new Date(value))
}

function formatMoney(value, currencyCode = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode || 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value || 0))
}

function formatHours(minutes) {
  const hours = Number(minutes || 0) / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(2)}h`
}

function node(tag, className = '', value = '') {
  const result = document.createElement(tag)
  if (className) result.className = className
  if (value) result.textContent = value
  return result
}

function setMessage(value = '', type = '') {
  elements.message.textContent = value
  elements.message.classList.toggle('error', type === 'error')
}

function setBusy(busy) {
  state.busy = busy
  elements.refresh.disabled = busy
  elements.body.querySelectorAll('[data-download-payslip]').forEach(button => {
    button.disabled = busy || button.dataset.pdfReady !== 'true'
  })
}

function renderSummary() {
  const latest = state.payslips[0] || null
  const pdfCount = state.payslips.filter(
    payslip => payslip.pdf?.generated
  ).length

  elements.count.textContent = String(state.payslips.length)
  elements.latestPayment.textContent = latest
    ? formatDate(latest.payment_date)
    : '—'
  elements.latestNet.textContent = latest
    ? formatMoney(latest.net_pay, latest.currency_code)
    : '—'
  elements.pdfCount.textContent =
    `${pdfCount} / ${state.payslips.length}`
}

function renderPrepaidSummary(summary = {}) {
  const cell = document.createElement('td')
  const wrapper = node('span', 'my-payslips-prepaid')
  wrapper.append(
    node('strong', '', `Closing: ${formatHours(summary.closing_minutes)}`),
    node(
      'span',
      '',
      `Added ${formatHours(summary.added_minutes)} · Applied ${formatHours(summary.applied_minutes)}`
    )
  )
  cell.append(wrapper)
  return cell
}

function renderActions(payslip) {
  const cell = document.createElement('td')
  const wrapper = node('div', 'my-payslips-actions')
  const record = encodeURIComponent(payslip.payroll_record_id)
  const preview = node('a', 'my-payslips-action primary', 'View')
  preview.href = `./payslip-preview.html?record=${record}`

  const print = node('a', 'my-payslips-action', 'Print')
  print.href = `./payslip-preview.html?record=${record}&print=1`

  const download = node('button', 'my-payslips-action', 'Download')
  download.type = 'button'
  download.dataset.downloadPayslip = payslip.payroll_record_id
  download.dataset.pdfReady = String(Boolean(payslip.pdf?.generated))
  download.disabled = !payslip.pdf?.generated
  if (download.disabled) {
    download.title = 'The finalized PDF has not been generated yet.'
  }

  wrapper.append(preview, download, print)
  cell.append(wrapper)
  return cell
}

function renderPayslips() {
  renderSummary()

  if (!state.payslips.length) {
    const row = document.createElement('tr')
    const cell = node(
      'td',
      'wf-empty',
      'No finalized payslips are available yet.'
    )
    cell.colSpan = 9
    row.append(cell)
    elements.body.replaceChildren(row)
    return
  }

  const fragment = document.createDocumentFragment()
  for (const payslip of state.payslips) {
    const row = document.createElement('tr')
    const payslipCell = document.createElement('td')
    payslipCell.append(
      node('span', 'my-payslips-number', payslip.payslip_number || '—'),
      node(
        'span',
        'wf-subtext',
        `Finalized ${formatDateTime(payslip.finalized_at)}`
      )
    )

    const periodCell = document.createElement('td')
    periodCell.append(
      node(
        'strong',
        '',
        `${formatDate(payslip.period_start)} – ${formatDate(payslip.period_end)}`
      ),
      node(
        'span',
        'wf-subtext',
        payslip.finalized_by_name
          ? `Approved by ${payslip.finalized_by_name}`
          : 'Finalized payroll'
      )
    )

    const pdfCell = document.createElement('td')
    pdfCell.append(
      node(
        'span',
        `wf-badge ${payslip.pdf?.generated ? 'success' : 'warning'}`,
        payslip.pdf?.generated ? 'Ready' : 'Pending'
      ),
      payslip.pdf?.generated
        ? node(
            'span',
            'wf-subtext',
            `Version ${payslip.pdf.document_version}`
          )
        : document.createTextNode('')
    )

    row.append(
      payslipCell,
      periodCell,
      node('td', '', formatDate(payslip.payment_date)),
      renderPrepaidSummary(payslip.prepaid_summary),
      node(
        'td',
        'my-payslips-money',
        formatMoney(payslip.gross_pay, payslip.currency_code)
      ),
      node(
        'td',
        'my-payslips-money',
        formatMoney(payslip.total_deductions, payslip.currency_code)
      ),
      node(
        'td',
        'my-payslips-money net',
        formatMoney(payslip.net_pay, payslip.currency_code)
      ),
      pdfCell,
      renderActions(payslip)
    )
    fragment.append(row)
  }
  elements.body.replaceChildren(fragment)
}

async function responseJson(response) {
  return response.json().catch(() => null)
}

async function downloadPayslip(payrollRecordId) {
  if (state.busy || !state.accessToken) return

  setBusy(true)
  setMessage('Creating a temporary private PDF link…')
  try {
    const response = await fetch('./api/payslips/signed-url', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${state.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ payrollRecordId }),
      cache: 'no-store'
    })
    const result = await responseJson(response)

    if (!response.ok || !result?.signedUrl) {
      throw new Error(
        result?.error || 'The temporary PDF download is unavailable.'
      )
    }

    setMessage(
      `Opening private PDF version ${result.documentVersion}. The link expires in ${result.expiresIn} seconds.`
    )
    window.location.assign(result.signedUrl)
  } catch (error) {
    setMessage(
      error?.message || 'The temporary PDF download is unavailable.',
      'error'
    )
  } finally {
    setBusy(false)
  }
}

async function loadPayslips() {
  setBusy(true)
  setMessage('Loading your finalized payslips…')
  try {
    const { data, error } = await supabase.rpc(
      'payroll_list_my_payslips'
    )
    if (error) throw error

    state.payslips = Array.isArray(data) ? data : []
    renderPayslips()
    setMessage(
      state.payslips.length
        ? `${state.payslips.length} finalized ${state.payslips.length === 1 ? 'payslip' : 'payslips'} available.`
        : 'Your finalized payslips will appear here after payroll approval and finalization.'
    )
  } catch (error) {
    state.payslips = []
    renderPayslips()
    setMessage(
      error?.message || 'Your payslips could not be loaded.',
      'error'
    )
  } finally {
    setBusy(false)
  }
}

async function initialize() {
  try {
    const access = await requireWorkforcePermission(
      supabase,
      'view_own_payslips',
      {
        returnTo: 'my-payslips.html',
        deniedPath: './home.html',
        deniedMessage: 'You do not have permission to view employee payslips.'
      }
    )
    if (!access) return

    state.accessToken = access.session?.access_token || ''
    document.body.classList.remove('my-payslips-access-pending')
    await loadPayslips()
  } catch {
    document.body.classList.remove('my-payslips-access-pending')
    setMessage(
      'Your payslips could not be opened. Sign in again or contact a payroll administrator.',
      'error'
    )
  }
}

elements.refresh.addEventListener('click', loadPayslips)
elements.body.addEventListener('click', event => {
  const button = event.target.closest('[data-download-payslip]')
  if (!button) return
  downloadPayslip(button.dataset.downloadPayslip)
})

initialize()
