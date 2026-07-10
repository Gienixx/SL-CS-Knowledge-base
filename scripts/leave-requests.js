import { supabase } from './supabaseClient.js?v=9'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

const STATUS_LABELS = Object.freeze({
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled'
})

const LEAVE_TYPE_LABELS = Object.freeze({
  vacation: 'Vacation',
  sick: 'Sick',
  emergency: 'Emergency',
  unpaid: 'Unpaid',
  other: 'Other'
})

const elements = {
  workforceLink: document.getElementById('leaveRequestsWorkforceLink'),
  totalCount: document.getElementById('leaveRequestTotalCount'),
  pendingCount: document.getElementById('leaveRequestPendingCount'),
  approvedCount: document.getElementById('leaveRequestApprovedCount'),
  rejectedCount: document.getElementById('leaveRequestRejectedCount'),
  form: document.getElementById('leaveRequestForm'),
  type: document.getElementById('leaveRequestType'),
  startDate: document.getElementById('leaveRequestStartDate'),
  endDate: document.getElementById('leaveRequestEndDate'),
  reason: document.getElementById('leaveRequestReason'),
  resetButton: document.getElementById('leaveRequestResetButton'),
  formMessage: document.getElementById('leaveRequestFormMessage'),
  refreshButton: document.getElementById('leaveRequestRefreshButton'),
  tableBody: document.getElementById('leaveRequestTableBody'),
  tableMessage: document.getElementById('leaveRequestTableMessage'),
  reviewModal: document.getElementById('leaveRequestReviewModal'),
  reviewForm: document.getElementById('leaveRequestReviewForm'),
  reviewEmployee: document.getElementById('leaveRequestReviewEmployee'),
  reviewType: document.getElementById('leaveRequestReviewType'),
  reviewDates: document.getElementById('leaveRequestReviewDates'),
  reviewAction: document.getElementById('leaveRequestReviewAction'),
  reviewNotes: document.getElementById('leaveRequestReviewNotes'),
  reviewMessage: document.getElementById('leaveRequestReviewMessage')
}

let access = null
let leaveRequests = []
let selectedReviewRequestId = null
let busy = false

function errorMessage(error) {
  return error?.message || 'An unexpected error occurred.'
}

function setFormMessage(text, type = '') {
  elements.formMessage.textContent = text
  elements.formMessage.className = type ? `wf-message ${type}` : 'wf-message'
}

function setTableMessage(text, type = '') {
  elements.tableMessage.textContent = text
  elements.tableMessage.className = type ? `wf-message ${type}` : 'wf-message'
}

function setReviewMessage(text, type = '') {
  elements.reviewMessage.textContent = text
  elements.reviewMessage.className = type ? `wf-message ${type}` : 'wf-message'
}

function resetForm() {
  elements.type.value = ''
  elements.startDate.value = ''
  elements.endDate.value = ''
  elements.reason.value = ''
  setFormMessage('')
}

function normalizeDate(value) {
  return value || ''
}

function formatDate(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date(value))
}

function formatLeaveDates(startDate, endDate) {
  if (!startDate) return '—'
  return startDate === endDate
    ? formatDate(startDate)
    : `${formatDate(startDate)} – ${formatDate(endDate)}`
}

function createCell(content, secondary = '', className = '') {
  const cell = document.createElement('td')
  const stack = document.createElement('div')
  stack.className = `team-attendance-cell-stack${className ? ` ${className}` : ''}`

  const main = document.createElement('span')
  main.className = 'team-attendance-time'
  main.textContent = content || '—'
  stack.appendChild(main)

  if (secondary) {
    const sub = document.createElement('span')
    sub.className = 'team-attendance-muted'
    sub.textContent = secondary
    stack.appendChild(sub)
  }

  cell.appendChild(stack)
  return cell
}

function createActionCell(request) {
  const cell = document.createElement('td')
  if (request.status === 'pending' && request.user_id === access.user_id) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'wf-btn secondary compact'
    button.textContent = 'Cancel'
    button.addEventListener('click', () => cancelLeaveRequest(request.id))
    cell.appendChild(button)
    return cell
  }

  if (request.status === 'pending' && hasWorkforcePermission(access, 'approve_leave')) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'wf-btn compact'
    button.textContent = 'Review'
    button.addEventListener('click', () => openReviewModal(request))
    cell.appendChild(button)
    return cell
  }

  cell.textContent = '—'
  return cell
}

function renderSummary(rows) {
  elements.totalCount.textContent = rows.length
  elements.pendingCount.textContent = rows.filter(row => row.status === 'pending').length
  elements.approvedCount.textContent = rows.filter(row => row.status === 'approved').length
  elements.rejectedCount.textContent = rows.filter(row => row.status === 'rejected').length
}

function renderTable() {
  elements.tableBody.replaceChildren()

  if (!leaveRequests.length) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 10
    cell.className = 'wf-empty'
    cell.textContent = 'No leave requests have been submitted yet.'
    row.appendChild(cell)
    elements.tableBody.appendChild(row)
    renderSummary([])
    setTableMessage('')
    return
  }

  leaveRequests.forEach(request => {
    const row = document.createElement('tr')
    row.append(
      createCell(request.full_name || 'You'),
      createCell(LEAVE_TYPE_LABELS[request.leave_type] || request.leave_type),
      createCell(formatLeaveDates(request.start_date, request.end_date)),
      createCell(STATUS_LABELS[request.status] || request.status),
      createCell(request.reason),
      createCell(request.review_notes || ''),
      createCell(request.reviewed_by_name || '—'),
      createCell(formatDate(request.created_at)),
      createCell(formatDate(request.updated_at)),
      createActionCell(request)
    )
    elements.tableBody.appendChild(row)
  })

  renderSummary(leaveRequests)
  setTableMessage(`${leaveRequests.length} leave request${leaveRequests.length === 1 ? '' : 's'} loaded.`)
}

function openReviewModal(request) {
  if (!elements.reviewModal) return
  selectedReviewRequestId = request.id
  elements.reviewEmployee.value = request.full_name || 'Unknown employee'
  elements.reviewType.value = LEAVE_TYPE_LABELS[request.leave_type] || request.leave_type
  elements.reviewDates.value = formatLeaveDates(request.start_date, request.end_date)
  elements.reviewAction.value = 'approved'
  elements.reviewNotes.value = ''
  setReviewMessage('')
  elements.reviewModal.hidden = false
  document.body.classList.add('modal-open')
}

function closeReviewModal() {
  if (!elements.reviewModal) return
  elements.reviewModal.hidden = true
  document.body.classList.remove('modal-open')
}

async function loadLeaveRequests() {
  setTableMessage('Loading leave requests...')

  const { data, error } = await supabase
    .from('leave_requests')
    .select(`*, reviewed_by:profiles(full_name), user:profiles(full_name)`)
    .order('created_at', { ascending: false })

  if (error) {
    setTableMessage(errorMessage(error), 'error')
    return
  }

  leaveRequests = (data || []).map(request => ({
    ...request,
    full_name: request.user?.full_name || 'Unknown employee',
    reviewed_by_name: request.reviewed_by?.full_name || '—'
  }))
  renderTable()
}

async function submitLeaveRequest(event) {
  event.preventDefault()

  const leaveType = elements.type.value
  const startDate = normalizeDate(elements.startDate.value)
  const endDate = normalizeDate(elements.endDate.value)
  const reason = elements.reason.value.trim()

  if (!leaveType) {
    setFormMessage('Select a leave type.', 'error')
    return
  }

  if (!startDate || !endDate) {
    setFormMessage('Start date and end date are required.', 'error')
    return
  }

  if (endDate < startDate) {
    setFormMessage('End date cannot be earlier than start date.', 'error')
    return
  }

  if (!reason) {
    setFormMessage('Explain the reason for this leave request.', 'error')
    return
  }

  setFormMessage('Submitting leave request...')
  elements.form.querySelector('button[type=submit]').disabled = true

  const { data, error } = await supabase
    .from('leave_requests')
    .insert([
      {
        user_id: access.user_id,
        leave_type: leaveType,
        start_date: startDate,
        end_date: endDate,
        reason
      }
    ])
    .select('*')

  elements.form.querySelector('button[type=submit]').disabled = false

  if (error) {
    setFormMessage(errorMessage(error), 'error')
    return
  }

  setFormMessage('Leave request submitted successfully.', 'success')
  resetForm()
  await loadLeaveRequests()
}

async function cancelLeaveRequest(requestId) {
  if (!confirm('Cancel this pending leave request?')) {
    return
  }

  setTableMessage('Cancelling leave request...')
  const { error } = await supabase.rpc('workforce_cancel_leave_request', {
    p_request_id: requestId
  })

  if (error) {
    setTableMessage(errorMessage(error), 'error')
    return
  }

  setTableMessage('Leave request cancelled.', 'success')
  await loadLeaveRequests()
}

async function reviewLeaveRequest(event) {
  event.preventDefault()

  if (!selectedReviewRequestId) {
    setReviewMessage('No leave request selected for review.', 'error')
    return
  }

  const status = elements.reviewAction.value
  const notes = elements.reviewNotes.value.trim()

  setReviewMessage('Submitting review...')
  elements.reviewForm.querySelector('button[type=submit]').disabled = true

  const { data, error } = await supabase.rpc('workforce_review_leave_request', {
    p_request_id: selectedReviewRequestId,
    p_status: status,
    p_review_notes: notes || null
  })

  elements.reviewForm.querySelector('button[type=submit]').disabled = false

  if (error) {
    setReviewMessage(errorMessage(error), 'error')
    return
  }

  setReviewMessage('Review submitted successfully.', 'success')
  closeReviewModal()
  await loadLeaveRequests()
}

function bindEvents() {
  elements.form.addEventListener('submit', submitLeaveRequest)
  elements.resetButton.addEventListener('click', resetForm)
  elements.refreshButton.addEventListener('click', loadLeaveRequests)
  elements.reviewForm.addEventListener('submit', reviewLeaveRequest)
  document.querySelectorAll('[data-close]').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.close === 'leaveRequestReviewModal') {
        closeReviewModal()
      }
    })
  })
}

async function initialize() {
  access = await loadCurrentWorkforceAccess(supabase)

  if (!access.authenticated) {
    window.location.replace(`./login.html?returnTo=${encodeURIComponent('./leave-requests.html')}`)
    return
  }

  elements.workforceLink.hidden = !(
    access.is_admin === true && hasWorkforcePermission(access, 'manage_employees')
  )

  const canApproveLeave = hasWorkforcePermission(access, 'approve_leave')
  if (!canApproveLeave) {
    document.getElementById('leaveRequestReviewModal')?.remove()
  }

  bindEvents()
  resetForm()
  await loadLeaveRequests()
}

initialize().catch(error => {
  console.error('Leave requests initialization failed:', error)
  setFormMessage(errorMessage(error), 'error')
  setTableMessage(errorMessage(error), 'error')
})
