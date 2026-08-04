import { supabase } from './supabaseClient.js?v=10'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

const STATUS_LABELS = Object.freeze({
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Denied',
  cancelled: 'Cancelled'
})

const LEAVE_TYPE_LABELS = Object.freeze({
  incentive_vl: 'Incentive VL',
  birthday_vl: 'Birthday VL',
  leave_without_pay: 'Leave Without Pay',
  vacation: 'Vacation',
  sick: 'Sick',
  emergency: 'Emergency',
  unpaid: 'Unpaid',
  other: 'Other'
})

const elements = {
  page: document.getElementById('leaveRequestsPage'),
  pageTitle: document.getElementById('leaveRequestsPageTitle'),
  pageDescription: document.getElementById('leaveRequestsPageDescription'),
  workforceLink: document.getElementById('leaveRequestsWorkforceLink'),
  totalCount: document.getElementById('leaveRequestTotalCount'),
  pendingCount: document.getElementById('leaveRequestPendingCount'),
  approvedCount: document.getElementById('leaveRequestApprovedCount'),
  rejectedCount: document.getElementById('leaveRequestRejectedCount'),
  submissionSection: document.getElementById('leaveRequestSubmissionSection'),
  approvalSection: document.getElementById('leaveApprovalQueueSection'),
  approvalCount: document.getElementById('leaveApprovalQueueCount'),
  approvalTableBody: document.getElementById('leaveApprovalTableBody'),
  form: document.getElementById('leaveRequestForm'),
  type: document.getElementById('leaveRequestType'),
  startDate: document.getElementById('leaveRequestStartDate'),
  endDate: document.getElementById('leaveRequestEndDate'),
  reason: document.getElementById('leaveRequestReason'),
  resetButton: document.getElementById('leaveRequestResetButton'),
  submitButton: document.getElementById('leaveRequestSubmitButton'),
  formMessage: document.getElementById('leaveRequestFormMessage'),
  tableTitle: document.getElementById('leaveRequestTableTitle'),
  tableDescription: document.getElementById('leaveRequestTableDescription'),
  refreshButton: document.getElementById('leaveRequestRefreshButton'),
  tableBody: document.getElementById('leaveRequestTableBody'),
  tableMessage: document.getElementById('leaveRequestTableMessage'),
  reviewModal: document.getElementById('leaveRequestReviewModal'),
  reviewForm: document.getElementById('leaveRequestReviewForm'),
  reviewEmployee: document.getElementById('leaveRequestReviewEmployee'),
  reviewType: document.getElementById('leaveRequestReviewType'),
  reviewDates: document.getElementById('leaveRequestReviewDates'),
  reviewReason: document.getElementById('leaveRequestReviewReason'),
  reviewAction: document.getElementById('leaveRequestReviewAction'),
  reviewNotes: document.getElementById('leaveRequestReviewNotes'),
  reviewNotesLabel: document.getElementById('leaveRequestReviewNotesLabel'),
  reviewNotesHint: document.getElementById('leaveRequestReviewNotesHint'),
  reviewSubmitButton: document.getElementById('leaveRequestReviewSubmitButton'),
  reviewMessage: document.getElementById('leaveRequestReviewMessage')
}

let access = null
let leaveRequests = []
let selectedReviewRequestId = null
let isApproverView = false

function errorMessage(error) {
  return error?.message || 'An unexpected error occurred.'
}

function setMessage(element, text, type = '') {
  if (!element) return
  element.textContent = text
  element.className = type ? `wf-message ${type}` : 'wf-message'
}

function setFormMessage(text, type = '') {
  setMessage(elements.formMessage, text, type)
}

function setTableMessage(text, type = '') {
  setMessage(elements.tableMessage, text, type)
}

function setReviewMessage(text, type = '') {
  setMessage(elements.reviewMessage, text, type)
}

function resetForm({ clearMessage = true } = {}) {
  elements.form?.reset()
  if (clearMessage) setFormMessage('')
}

function normalizeDate(value) {
  return value || ''
}

function formatDate(value) {
  if (!value) return '—'
  const source = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T12:00:00`
    : value
  const date = new Date(source)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date)
}

function formatLeaveDates(startDate, endDate) {
  if (!startDate) return '—'
  return startDate === endDate
    ? formatDate(startDate)
    : `${formatDate(startDate)} – ${formatDate(endDate)}`
}

function createCell(content, secondary = '', className = '') {
  const cell = document.createElement('td')
  if (className) cell.className = className

  const stack = document.createElement('div')
  stack.className = 'leave-request-cell-stack'

  const main = document.createElement('span')
  main.className = 'leave-request-cell-main'
  main.textContent = content || '—'
  stack.appendChild(main)

  if (secondary) {
    const sub = document.createElement('span')
    sub.className = 'leave-request-cell-muted'
    sub.textContent = secondary
    stack.appendChild(sub)
  }

  cell.appendChild(stack)
  return cell
}

function createStatusCell(status) {
  const cell = document.createElement('td')
  const badge = document.createElement('span')
  badge.className = `leave-status ${status || 'pending'}`
  badge.textContent = STATUS_LABELS[status] || status || '—'
  cell.appendChild(badge)
  return cell
}

function createButton(label, className, handler) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = label
  button.addEventListener('click', handler)
  return button
}

function createHistoryActionCell(request) {
  const cell = document.createElement('td')

  if (
    !isApproverView &&
    request.status === 'pending' &&
    access?.linked_profile_ids?.includes(request.user_id)
  ) {
    cell.appendChild(createButton(
      'Cancel',
      'wf-btn secondary compact',
      () => cancelLeaveRequest(request.id)
    ))
    return cell
  }

  cell.textContent = '—'
  return cell
}

function createReviewActionCell(request) {
  const cell = document.createElement('td')
  cell.appendChild(createButton(
    'Review',
    'wf-btn compact',
    () => openReviewModal(request)
  ))
  return cell
}

function renderSummary(rows) {
  elements.totalCount.textContent = rows.length
  elements.pendingCount.textContent = rows.filter(row => row.status === 'pending').length
  elements.approvedCount.textContent = rows.filter(row => row.status === 'approved').length
  elements.rejectedCount.textContent = rows.filter(row => row.status === 'rejected').length
}

function renderApprovalQueue() {
  if (!isApproverView || !elements.approvalTableBody) return

  const pendingRequests = leaveRequests.filter(request => request.status === 'pending')
  elements.approvalTableBody.replaceChildren()
  elements.approvalCount.textContent = `${pendingRequests.length} pending`

  if (!pendingRequests.length) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 6
    cell.className = 'wf-empty'
    cell.textContent = 'No leave requests are waiting for approval.'
    row.appendChild(cell)
    elements.approvalTableBody.appendChild(row)
    return
  }

  pendingRequests.forEach(request => {
    const row = document.createElement('tr')
    row.append(
      createCell(request.full_name),
      createCell(LEAVE_TYPE_LABELS[request.leave_type] || request.leave_type),
      createCell(formatLeaveDates(request.start_date, request.end_date)),
      createCell(request.reason, '', 'leave-reason-cell'),
      createCell(formatDate(request.created_at)),
      createReviewActionCell(request)
    )
    elements.approvalTableBody.appendChild(row)
  })
}

function renderHistory() {
  const rows = isApproverView
    ? leaveRequests.filter(request => request.status !== 'pending')
    : leaveRequests

  elements.tableBody.replaceChildren()

  if (!rows.length) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 8
    cell.className = 'wf-empty'
    cell.textContent = isApproverView
      ? 'No reviewed leave requests yet.'
      : 'You have not submitted a leave request yet.'
    row.appendChild(cell)
    elements.tableBody.appendChild(row)
    return
  }

  rows.forEach(request => {
    const decisionReason = request.status === 'rejected'
      ? request.review_notes || 'No reason was recorded.'
      : request.review_notes || '—'

    const row = document.createElement('tr')
    row.append(
      createCell(request.full_name || 'You'),
      createCell(LEAVE_TYPE_LABELS[request.leave_type] || request.leave_type),
      createCell(formatLeaveDates(request.start_date, request.end_date)),
      createStatusCell(request.status),
      createCell(request.reason, '', 'leave-reason-cell'),
      createCell(decisionReason, '', request.status === 'rejected' ? 'leave-denial-reason' : ''),
      createCell(formatDate(request.reviewed_at)),
      createHistoryActionCell(request)
    )
    elements.tableBody.appendChild(row)
  })
}

function renderLeaveRequests() {
  renderSummary(leaveRequests)
  renderApprovalQueue()
  renderHistory()
  setTableMessage(`${leaveRequests.length} leave request${leaveRequests.length === 1 ? '' : 's'} loaded.`)
}

function updateReviewNotesRequirement() {
  const isDenied = elements.reviewAction?.value === 'rejected'
  elements.reviewNotes.required = isDenied
  elements.reviewNotesLabel.textContent = isDenied
    ? 'Denial reason'
    : 'Decision notes (optional)'
  elements.reviewNotes.placeholder = isDenied
    ? 'Explain why this request is being denied'
    : 'Add an optional approval note'
  elements.reviewNotesHint.textContent = isDenied
    ? 'The agent will see this reason in their leave-request history.'
    : 'Approval will automatically update the agent’s schedule.'
  elements.reviewSubmitButton.textContent = isDenied
    ? 'Deny request'
    : 'Approve request'
}

function openReviewModal(request) {
  if (!elements.reviewModal) return
  selectedReviewRequestId = request.id
  elements.reviewEmployee.value = request.full_name || 'Unknown employee'
  elements.reviewType.value = LEAVE_TYPE_LABELS[request.leave_type] || request.leave_type
  elements.reviewDates.value = formatLeaveDates(request.start_date, request.end_date)
  elements.reviewReason.value = request.reason || '—'
  elements.reviewAction.value = 'approved'
  elements.reviewNotes.value = ''
  updateReviewNotesRequirement()
  setReviewMessage('')
  elements.reviewModal.hidden = false
  document.body.classList.add('modal-open')
}

function closeReviewModal() {
  if (!elements.reviewModal) return
  elements.reviewModal.hidden = true
  selectedReviewRequestId = null
  document.body.classList.remove('modal-open')
}

async function loadLeaveRequests() {
  setTableMessage('Loading leave requests...')
  elements.refreshButton.disabled = true

  const { data, error } = await supabase
    .from('leave_requests')
    .select('*, user:profiles!leave_requests_user_id_fkey(full_name)')
    .order('created_at', { ascending: false })

  elements.refreshButton.disabled = false

  if (error) {
    setTableMessage(errorMessage(error), 'error')
    return
  }

  leaveRequests = (data || []).map(request => ({
    ...request,
    full_name: request.user?.full_name || (isApproverView ? 'Unknown employee' : 'You')
  }))
  renderLeaveRequests()
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
  elements.submitButton.disabled = true

  const { error } = await supabase.rpc('workforce_submit_leave_request', {
    p_leave_type: leaveType,
    p_start_date: startDate,
    p_end_date: endDate,
    p_reason: reason
  })

  elements.submitButton.disabled = false

  if (error) {
    setFormMessage(errorMessage(error), 'error')
    return
  }

  resetForm({ clearMessage: false })
  setFormMessage('Leave request submitted. An administrator has been notified.', 'success')
  await loadLeaveRequests()
}

async function cancelLeaveRequest(requestId) {
  if (!window.confirm('Cancel this pending leave request?')) return

  setTableMessage('Cancelling leave request...')
  const { error } = await supabase.rpc('workforce_cancel_leave_request', {
    p_request_id: requestId
  })

  if (error) {
    setTableMessage(errorMessage(error), 'error')
    return
  }

  await loadLeaveRequests()
  setTableMessage('Leave request cancelled.', 'success')
}

async function reviewLeaveRequest(event) {
  event.preventDefault()

  if (!selectedReviewRequestId) {
    setReviewMessage('No leave request selected for review.', 'error')
    return
  }

  const status = elements.reviewAction.value
  const notes = elements.reviewNotes.value.trim()

  if (status === 'rejected' && !notes) {
    setReviewMessage('Enter the reason for denying this request.', 'error')
    elements.reviewNotes.focus()
    return
  }

  setReviewMessage(status === 'approved'
    ? 'Approving request and updating the schedule...'
    : 'Submitting denial...')
  elements.reviewSubmitButton.disabled = true

  const { error } = await supabase.rpc('workforce_review_leave_request', {
    p_request_id: selectedReviewRequestId,
    p_status: status,
    p_review_notes: notes || null
  })

  elements.reviewSubmitButton.disabled = false

  if (error) {
    setReviewMessage(errorMessage(error), 'error')
    return
  }

  closeReviewModal()
  await loadLeaveRequests()
  setTableMessage(status === 'approved'
    ? 'Leave approved and the agent’s schedule was updated.'
    : 'Leave request denied. The reason is now visible to the agent.', 'success')
}

function configureRoleView() {
  elements.submissionSection.hidden = isApproverView
  elements.approvalSection.hidden = !isApproverView

  if (isApproverView) {
    elements.pageTitle.textContent = 'Leave Request Approvals'
    elements.pageDescription.textContent = 'Review agent leave requests and keep approved leave synchronized with their schedules.'
    elements.tableTitle.textContent = 'Approval history'
    elements.tableDescription.textContent = 'Previously approved, denied, or cancelled leave requests in your authorized scope.'
  } else {
    elements.pageTitle.textContent = 'My Leave Requests'
    elements.pageDescription.textContent = 'File a leave request and track the administrator’s decision.'
    elements.tableTitle.textContent = 'My leave requests'
    elements.tableDescription.textContent = 'Denied requests display the administrator’s reason here.'
  }
}

function bindEvents() {
  if (!isApproverView) {
    elements.form.addEventListener('submit', submitLeaveRequest)
    elements.resetButton.addEventListener('click', () => resetForm())
  }

  elements.refreshButton.addEventListener('click', loadLeaveRequests)

  if (isApproverView) {
    elements.reviewForm.addEventListener('submit', reviewLeaveRequest)
    elements.reviewAction.addEventListener('change', updateReviewNotesRequirement)
  }

  document.querySelectorAll('[data-close="leaveRequestReviewModal"]').forEach(button => {
    button.addEventListener('click', closeReviewModal)
  })
}

async function initialize() {
  access = await loadCurrentWorkforceAccess(supabase)

  if (!access.authenticated) {
    window.location.replace(`./login.html?returnTo=${encodeURIComponent('./leave-requests.html')}`)
    return
  }

  if (!access.allowed) {
    window.alert('An active workforce profile is required to access leave requests.')
    window.location.replace('./home.html')
    return
  }

  isApproverView = access.is_admin === true &&
    hasWorkforcePermission(access, 'approve_leave')

  if (!isApproverView && access.is_agent !== true) {
    window.alert('You do not have access to leave requests.')
    window.location.replace('./home.html')
    return
  }

  elements.workforceLink.hidden = !(
    access.is_admin === true && hasWorkforcePermission(access, 'manage_employees')
  )

  if (!isApproverView) {
    elements.reviewModal?.remove()
  }

  configureRoleView()
  elements.page.hidden = false
  document.documentElement.classList.remove('leave-role-pending')
  bindEvents()
  resetForm()
  await loadLeaveRequests()
}

initialize().catch(error => {
  console.error('Leave requests initialization failed:', error)
  setFormMessage(errorMessage(error), 'error')
  setTableMessage(errorMessage(error), 'error')
})
