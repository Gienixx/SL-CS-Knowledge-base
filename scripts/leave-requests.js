import { supabase } from './supabaseClient.js?v=11'
import { hasWorkforcePermission, loadCurrentWorkforceAccess } from './workforce-permissions.js?v=1'

const STATUS_LABELS = Object.freeze({ pending: 'Pending', approved: 'Approved', rejected: 'Denied', cancelled: 'Cancelled' })
const LEAVE_TYPE_LABELS = Object.freeze({
  incentive_vl: 'Incentive Leave (Incentive VL)', birthday_vl: 'Birthday Leave (Birthday VL)', leave_without_pay: 'Leave Without Pay',
  vacation: 'Vacation', sick: 'Sick', emergency: 'Emergency', unpaid: 'Unpaid', other: 'Other'
})
const SCHEDULE_REQUEST_LABELS = Object.freeze({ open_schedule: 'Open Schedule', slide_shift: 'Slide Shift' })

const elements = {
  page: document.getElementById('leaveRequestsPage'), pageTitle: document.getElementById('leaveRequestsPageTitle'),
  pageDescription: document.getElementById('leaveRequestsPageDescription'), workforceLink: document.getElementById('leaveRequestsWorkforceLink'),
  totalCount: document.getElementById('leaveRequestTotalCount'), pendingCount: document.getElementById('leaveRequestPendingCount'),
  approvedCount: document.getElementById('leaveRequestApprovedCount'), rejectedCount: document.getElementById('leaveRequestRejectedCount'),
  submissionSection: document.getElementById('leaveRequestSubmissionSection'), approvalSection: document.getElementById('leaveApprovalQueueSection'),
  approvalCount: document.getElementById('leaveApprovalQueueCount'), approvalTableBody: document.getElementById('leaveApprovalTableBody'),
  form: document.getElementById('leaveRequestForm'), category: document.getElementById('leaveRequestCategory'),
  type: document.getElementById('leaveRequestType'), targetScheduleField: document.getElementById('leaveRequestTargetScheduleField'),
  targetSchedule: document.getElementById('leaveRequestTargetSchedule'), startDate: document.getElementById('leaveRequestStartDate'),
  startDateLabel: document.getElementById('leaveRequestStartDateLabel'), endDateField: document.getElementById('leaveRequestEndDateField'),
  endDate: document.getElementById('leaveRequestEndDate'), plannedMinutesField: document.getElementById('leaveRequestPlannedMinutesField'),
  plannedMinutes: document.getElementById('leaveRequestPlannedMinutes'), shiftTimes: document.getElementById('leaveRequestShiftTimes'),
  shiftStart: document.getElementById('leaveRequestShiftStart'), shiftEnd: document.getElementById('leaveRequestShiftEnd'),
  reason: document.getElementById('leaveRequestReason'), resetButton: document.getElementById('leaveRequestResetButton'),
  submitButton: document.getElementById('leaveRequestSubmitButton'), formMessage: document.getElementById('leaveRequestFormMessage'),
  tableTitle: document.getElementById('leaveRequestTableTitle'), tableDescription: document.getElementById('leaveRequestTableDescription'),
  refreshButton: document.getElementById('leaveRequestRefreshButton'), tableBody: document.getElementById('leaveRequestTableBody'),
  tableMessage: document.getElementById('leaveRequestTableMessage'), reviewModal: document.getElementById('leaveRequestReviewModal'),
  reviewForm: document.getElementById('leaveRequestReviewForm'), reviewEmployee: document.getElementById('leaveRequestReviewEmployee'),
  reviewCategory: document.getElementById('leaveRequestReviewCategory'), reviewType: document.getElementById('leaveRequestReviewType'),
  reviewDates: document.getElementById('leaveRequestReviewDates'), reviewSchedule: document.getElementById('leaveRequestReviewSchedule'),
  reviewReason: document.getElementById('leaveRequestReviewReason'), reviewAction: document.getElementById('leaveRequestReviewAction'),
  reviewNotes: document.getElementById('leaveRequestReviewNotes'), reviewNotesLabel: document.getElementById('leaveRequestReviewNotesLabel'),
  reviewNotesHint: document.getElementById('leaveRequestReviewNotesHint'), reviewSubmitButton: document.getElementById('leaveRequestReviewSubmitButton'),
  reviewMessage: document.getElementById('leaveRequestReviewMessage')
}

let access = null
let requests = []
let schedules = []
let selectedReviewRequest = null
let isApproverView = false

const errorMessage = error => error?.message || 'An unexpected error occurred.'
function setMessage(element, text, type = '') { if (element) { element.textContent = text; element.className = type ? `wf-message ${type}` : 'wf-message' } }
function formatDate(value) {
  if (!value) return '—'
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(date)
}
function formatDateRange(request) { return !request?.start_date ? '—' : request.start_date === request.end_date ? formatDate(request.start_date) : `${formatDate(request.start_date)} – ${formatDate(request.end_date)}` }
function formatDateTime(value, timeZone = 'America/New_York') { return value ? new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—' }
function requestCategoryLabel(request) { return request?.request_category === 'schedule_change' ? 'Schedule Change' : 'Leave' }
function requestTypeLabel(request) { return request?.request_category === 'schedule_change' ? SCHEDULE_REQUEST_LABELS[request.request_type] || request.request_type : LEAVE_TYPE_LABELS[request?.leave_type] || request?.leave_type || 'Leave' }
function scheduleLabel(schedule) {
  if (!schedule) return 'No existing schedule'
  if (schedule.is_leave) return LEAVE_TYPE_LABELS[schedule.leave_type] || 'Leave schedule'
  if (schedule.is_absent) return 'Absence schedule'
  if (schedule.is_rest_day) return 'Rest day'
  if (!schedule.shift_start || !schedule.shift_end) return 'Open Schedule'
  return `${formatDateTime(schedule.shift_start, schedule.timezone)} – ${formatDateTime(schedule.shift_end, schedule.timezone)}`
}
function requestedScheduleLabel(request) {
  if (request?.request_category !== 'schedule_change') return scheduleLabel(request?.target_schedule)
  if (request.request_type === 'open_schedule') return `Open Schedule · ${request.requested_planned_paid_minutes || '—'} planned minutes${request.target_schedule ? ` · current: ${scheduleLabel(request.target_schedule)}` : ''}`
  return `Slide Shift · ${formatDateTime(request.requested_shift_start)} – ${formatDateTime(request.requested_shift_end)}${request.target_schedule ? ` · current: ${scheduleLabel(request.target_schedule)}` : ''}`
}
function createCell(content, secondary = '', className = '') {
  const cell = document.createElement('td'); if (className) cell.className = className
  const stack = document.createElement('div'); stack.className = 'leave-request-cell-stack'
  const main = document.createElement('span'); main.className = 'leave-request-cell-main'; main.textContent = content || '—'; stack.appendChild(main)
  if (secondary) { const sub = document.createElement('span'); sub.className = 'leave-request-cell-muted'; sub.textContent = secondary; stack.appendChild(sub) }
  cell.appendChild(stack); return cell
}
function createStatusCell(status) { const cell = document.createElement('td'); const badge = document.createElement('span'); badge.className = `leave-status ${status || 'pending'}`; badge.textContent = STATUS_LABELS[status] || status || '—'; cell.appendChild(badge); return cell }
function createButton(label, handler, disabled = false) { const button = document.createElement('button'); button.type = 'button'; button.className = 'wf-btn compact'; button.textContent = label; button.disabled = disabled; button.addEventListener('click', handler); return button }
function selectedSchedule() { return schedules.find(schedule => schedule.id === elements.targetSchedule?.value) || null }

function zoneParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(timestamp))
  return Object.fromEntries(parts.map(part => [part.type, Number(part.value)]))
}
function zonedDateTimeToIso(localValue, timeZone = 'America/New_York') {
  if (!localValue) return null
  const match = localValue.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/)
  if (!match) throw new Error('Enter a valid requested date and time.')
  const [, year, month, day, hour, minute] = match.map(Number); const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0)
  const offset = timestamp => { const parts = zoneParts(timestamp, timeZone); return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - timestamp }
  let timestamp = utcGuess - offset(utcGuess); timestamp = utcGuess - offset(timestamp); return new Date(timestamp).toISOString()
}

function populateRequestTypes() {
  const options = elements.category.value === 'schedule_change' ? [['open_schedule', 'Open Schedule'], ['slide_shift', 'Slide Shift']] : [['incentive_vl', 'Incentive Leave (Incentive VL)'], ['birthday_vl', 'Birthday Leave (Birthday VL)'], ['leave_without_pay', 'Leave Without Pay']]
  const previous = elements.type.value; elements.type.replaceChildren(new Option('Select request type', ''))
  options.forEach(([value, label]) => elements.type.appendChild(new Option(label, value)))
  if (options.some(([value]) => value === previous)) elements.type.value = previous
}
function populateTargetSchedules() {
  const selectedDate = elements.startDate.value; const previous = elements.targetSchedule.value
  elements.targetSchedule.replaceChildren(new Option('No existing schedule / create one', ''))
  schedules.filter(schedule => (!selectedDate || schedule.shift_date === selectedDate) && !schedule.is_leave && !schedule.is_absent && !schedule.is_rest_day && !schedule.is_holiday).sort((a, b) => String(a.shift_start || '').localeCompare(String(b.shift_start || ''))).forEach(schedule => elements.targetSchedule.appendChild(new Option(`${formatDate(schedule.shift_date)} · ${scheduleLabel(schedule)}`, schedule.id)))
  if ([...elements.targetSchedule.options].some(option => option.value === previous)) elements.targetSchedule.value = previous
}
function updateFormFields() {
  const isScheduleChange = elements.category.value === 'schedule_change'; const isOpen = isScheduleChange && elements.type.value === 'open_schedule'; const isSlide = isScheduleChange && elements.type.value === 'slide_shift'
  elements.targetScheduleField.hidden = !isScheduleChange; elements.plannedMinutesField.hidden = !isOpen; elements.shiftTimes.hidden = !isSlide; elements.endDateField.hidden = isScheduleChange
  elements.endDate.required = !isScheduleChange; elements.startDateLabel.textContent = isScheduleChange ? 'Target work date' : 'Start date'; elements.targetSchedule.required = isSlide
  if (isScheduleChange) elements.endDate.value = elements.startDate.value
  if (!isScheduleChange) { elements.targetSchedule.value = ''; elements.plannedMinutes.value = ''; elements.shiftStart.value = ''; elements.shiftEnd.value = '' }
  populateTargetSchedules()
}
function resetForm({ clearMessage = true } = {}) { elements.form?.reset(); populateRequestTypes(); updateFormFields(); if (clearMessage) setMessage(elements.formMessage, '') }

function renderSummary(rows) { elements.totalCount.textContent = rows.length; elements.pendingCount.textContent = rows.filter(row => row.status === 'pending').length; elements.approvedCount.textContent = rows.filter(row => row.status === 'approved').length; elements.rejectedCount.textContent = rows.filter(row => row.status === 'rejected').length }
function canReview(request) { return isApproverView && request.status === 'pending' && (request.request_category !== 'schedule_change' || access?.can_manage_schedules === true) }
function createReviewActionCell(request) { const cell = document.createElement('td'); if (request.status !== 'pending') { cell.textContent = '—'; return cell } const allowed = canReview(request); cell.appendChild(createButton(allowed ? 'Review' : 'Missing schedule permission', () => openReviewModal(request), !allowed)); return cell }
function renderApprovalQueue() {
  if (!isApproverView) return
  const pending = requests.filter(request => request.status === 'pending'); elements.approvalCount.textContent = `${pending.length} pending`; elements.approvalTableBody.replaceChildren()
  if (!pending.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 6; cell.className = 'wf-empty'; cell.textContent = 'No schedule requests are waiting for approval.'; row.appendChild(cell); elements.approvalTableBody.appendChild(row); return }
  pending.forEach(request => { const row = document.createElement('tr'); row.append(createCell(request.full_name || 'Unknown employee'), createCell(requestTypeLabel(request), requestCategoryLabel(request)), createCell(formatDateRange(request)), createCell(request.reason, requestedScheduleLabel(request), 'leave-reason-cell'), createCell(formatDateTime(request.created_at)), createReviewActionCell(request)); elements.approvalTableBody.appendChild(row) })
}
function renderHistory() {
  elements.tableBody.replaceChildren()
  if (!requests.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 8; cell.className = 'wf-empty'; cell.textContent = isApproverView ? 'No reviewed schedule requests yet.' : 'You have not submitted a schedule request yet.'; row.appendChild(cell); elements.tableBody.appendChild(row); return }
  requests.forEach(request => {
    const row = document.createElement('tr'); const denial = request.status === 'rejected' ? request.review_notes || 'Denied without a reason.' : '—'; const action = document.createElement('td')
    if (!isApproverView && request.status === 'pending' && access?.linked_profile_ids?.includes(request.user_id)) action.appendChild(createButton('Cancel', () => cancelRequest(request.id)))
    else action.textContent = '—'
    row.append(createCell(request.full_name || 'You'), createCell(requestTypeLabel(request), requestCategoryLabel(request)), createCell(formatDateRange(request)), createStatusCell(request.status), createCell(request.reason, requestedScheduleLabel(request), 'leave-reason-cell'), createCell(denial, '', request.status === 'rejected' ? 'leave-denial-reason' : ''), createCell(formatDateTime(request.reviewed_at)), action); elements.tableBody.appendChild(row)
  })
}
function renderRequests() { renderSummary(requests); renderApprovalQueue(); renderHistory() }
function openReviewModal(request) { selectedReviewRequest = request; elements.reviewEmployee.value = request.full_name || 'Unknown employee'; elements.reviewCategory.value = requestCategoryLabel(request); elements.reviewType.value = requestTypeLabel(request); elements.reviewDates.value = formatDateRange(request); elements.reviewSchedule.value = requestedScheduleLabel(request); elements.reviewReason.value = request.reason || '—'; elements.reviewAction.value = 'approved'; elements.reviewNotes.value = ''; updateReviewNotesRequirement(); setMessage(elements.reviewMessage, ''); elements.reviewModal.hidden = false; document.body.classList.add('modal-open') }
function closeReviewModal() { elements.reviewModal.hidden = true; selectedReviewRequest = null; document.body.classList.remove('modal-open') }
function updateReviewNotesRequirement() { const denied = elements.reviewAction.value === 'rejected'; elements.reviewNotes.required = denied; elements.reviewNotesLabel.textContent = denied ? 'Denial reason (required)' : 'Decision notes (optional)'; elements.reviewNotesHint.textContent = denied ? 'The agent will see this exact reason in schedule-request history.' : 'Approval applies the request through Schedule Management.'; elements.reviewSubmitButton.textContent = denied ? 'Deny request' : 'Approve request' }

async function loadSchedules() {
  if (isApproverView) return
  const { data, error } = await supabase.from('work_schedules').select('id, user_id, shift_date, shift_sequence, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, is_leave, is_absent, leave_type').order('shift_date', { ascending: false })
  if (error) { schedules = []; setMessage(elements.formMessage, 'Existing schedules could not be loaded; Open Schedule requests can still specify a date.', 'error'); return }
  schedules = data || []; populateTargetSchedules()
}
async function loadRequests() {
  setMessage(elements.tableMessage, 'Loading schedule requests...'); elements.refreshButton.disabled = true
  const { data, error } = await supabase.from('leave_requests').select('*, user:profiles!leave_requests_user_id_fkey(full_name), target_schedule:work_schedules!leave_requests_target_schedule_id_fkey(id, shift_date, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, is_leave, is_absent, leave_type)').order('created_at', { ascending: false })
  elements.refreshButton.disabled = false
  if (error) { setMessage(elements.tableMessage, errorMessage(error), 'error'); return }
  requests = (data || []).map(request => ({ ...request, full_name: request.user?.full_name || (isApproverView ? 'Unknown employee' : 'You') })); renderRequests(); setMessage(elements.tableMessage, `${requests.length} schedule request${requests.length === 1 ? '' : 's'} loaded.`)
}
async function cancelRequest(requestId) {
  if (!window.confirm('Cancel this pending schedule request?')) return
  const { error } = await supabase.rpc('workforce_cancel_leave_request', { p_request_id: requestId })
  if (error) { setMessage(elements.tableMessage, errorMessage(error), 'error'); return }
  await loadRequests(); setMessage(elements.tableMessage, 'Schedule request cancelled.', 'success')
}

async function submitRequest(event) {
  event.preventDefault(); const category = elements.category.value; const type = elements.type.value; const startDate = elements.startDate.value; const endDate = elements.endDate.value; const reason = elements.reason.value.trim()
  if (!type || !startDate || !reason) { setMessage(elements.formMessage, 'Request type, target date, and reason are required.', 'error'); return }
  if (category === 'leave') {
    if (!endDate || endDate < startDate) { setMessage(elements.formMessage, 'End date cannot be earlier than start date.', 'error'); return }
    elements.submitButton.disabled = true; setMessage(elements.formMessage, 'Submitting leave request...')
    const { error } = await supabase.rpc('workforce_submit_leave_request', { p_leave_type: type, p_start_date: startDate, p_end_date: endDate, p_reason: reason }); elements.submitButton.disabled = false
    if (error) { setMessage(elements.formMessage, errorMessage(error), 'error'); return }
  } else {
    const target = selectedSchedule(); const plannedMinutes = type === 'open_schedule' ? Number(elements.plannedMinutes.value) : null; let requestedStart = null; let requestedEnd = null
    if (type === 'slide_shift') {
      if (!target || !elements.shiftStart.value || !elements.shiftEnd.value) { setMessage(elements.formMessage, 'Slide Shift requires an existing schedule and both requested times.', 'error'); return }
      try { requestedStart = zonedDateTimeToIso(elements.shiftStart.value); requestedEnd = zonedDateTimeToIso(elements.shiftEnd.value) } catch (error) { setMessage(elements.formMessage, errorMessage(error), 'error'); return }
      if (requestedEnd <= requestedStart) { setMessage(elements.formMessage, 'Requested shift end must be later than its start.', 'error'); return }
    }
    if (type === 'open_schedule' && (!Number.isInteger(plannedMinutes) || plannedMinutes < 15 || plannedMinutes > 1440)) { setMessage(elements.formMessage, 'Open Schedule planned paid minutes must be between 15 and 1440.', 'error'); return }
    elements.submitButton.disabled = true; setMessage(elements.formMessage, 'Submitting schedule-change request...')
    const { error } = await supabase.rpc('workforce_submit_schedule_request', { p_request_type: type, p_work_date: startDate, p_target_schedule_id: target?.id || null, p_requested_shift_start: requestedStart, p_requested_shift_end: requestedEnd, p_requested_planned_paid_minutes: Number.isInteger(plannedMinutes) ? plannedMinutes : null, p_reason: reason }); elements.submitButton.disabled = false
    if (error) { setMessage(elements.formMessage, errorMessage(error), 'error'); return }
  }
  resetForm({ clearMessage: false }); setMessage(elements.formMessage, 'Schedule request submitted. An administrator has been notified.', 'success'); await loadRequests()
}
async function reviewRequest(event) {
  event.preventDefault(); if (!selectedReviewRequest) return; const status = elements.reviewAction.value; const notes = elements.reviewNotes.value.trim()
  if (status === 'rejected' && !notes) { setMessage(elements.reviewMessage, 'Enter the reason for denying this request.', 'error'); elements.reviewNotes.focus(); return }
  elements.reviewSubmitButton.disabled = true; setMessage(elements.reviewMessage, status === 'approved' ? 'Applying request to Schedule Management...' : 'Submitting denial...')
  const rpcName = selectedReviewRequest.request_category === 'schedule_change' ? 'workforce_review_schedule_request' : 'workforce_review_leave_request'
  const { error } = await supabase.rpc(rpcName, { p_request_id: selectedReviewRequest.id, p_status: status, p_review_notes: notes || null }); elements.reviewSubmitButton.disabled = false
  if (error) { setMessage(elements.reviewMessage, errorMessage(error), 'error'); return }
  closeReviewModal(); await loadRequests(); setMessage(elements.tableMessage, status === 'approved' ? 'Request approved and Schedule Management was updated.' : 'Request denied; the reason is now visible to the agent.', 'success')
}
function configureRoleView() {
  elements.submissionSection.hidden = isApproverView; elements.approvalSection.hidden = !isApproverView
  if (isApproverView) { elements.pageTitle.textContent = 'Schedule Request Approvals'; elements.pageDescription.textContent = 'Review agent leave and schedule-change requests through Schedule Management.'; elements.tableTitle.textContent = 'Request history'; elements.tableDescription.textContent = 'Reviewed requests in your authorized workforce scope.' }
  else { elements.pageTitle.textContent = 'My Schedule Requests'; elements.pageDescription.textContent = 'Request leave or a schedule change and track the administrator’s decision.'; elements.tableTitle.textContent = 'My schedule requests'; elements.tableDescription.textContent = 'Denied requests display the administrator’s reason here.' }
}
function bindEvents() {
  if (!isApproverView) {
    elements.form.addEventListener('submit', submitRequest); elements.resetButton.addEventListener('click', () => resetForm())
    elements.category.addEventListener('change', () => { populateRequestTypes(); updateFormFields() }); elements.type.addEventListener('change', updateFormFields); elements.startDate.addEventListener('change', updateFormFields)
  }
  elements.refreshButton.addEventListener('click', loadRequests)
  if (isApproverView) { elements.reviewForm.addEventListener('submit', reviewRequest); elements.reviewAction.addEventListener('change', updateReviewNotesRequirement) }
  document.querySelectorAll('[data-close="leaveRequestReviewModal"]').forEach(button => button.addEventListener('click', closeReviewModal))
}
async function initialize() {
  access = await loadCurrentWorkforceAccess(supabase)
  if (!access.authenticated) { window.location.replace(`./login.html?returnTo=${encodeURIComponent('./leave-requests.html')}`); return }
  if (!access.allowed) { window.alert('An active workforce profile is required to access schedule requests.'); window.location.replace('./home.html'); return }
  access.can_manage_schedules = access.is_admin === true && hasWorkforcePermission(access, 'manage_schedules')
  isApproverView = access.is_admin === true && (hasWorkforcePermission(access, 'approve_leave') || access.can_manage_schedules)
  if (!isApproverView && access.is_agent !== true) { window.alert('You do not have access to schedule requests.'); window.location.replace('./home.html'); return }
  elements.workforceLink.hidden = !(access.is_admin === true && hasWorkforcePermission(access, 'manage_employees'))
  if (!isApproverView) elements.reviewModal?.remove()
  configureRoleView(); elements.page.hidden = false; document.documentElement.classList.remove('leave-role-pending'); bindEvents(); resetForm(); await loadSchedules(); await loadRequests()
}
initialize().catch(error => { console.error('Schedule requests initialization failed:', error); setMessage(elements.formMessage, errorMessage(error), 'error'); setMessage(elements.tableMessage, errorMessage(error), 'error') })
