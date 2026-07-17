import { supabase } from './supabaseClient.js?v=9'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

const section = document.getElementById('scheduleManagementSection')

if (section) {
  const scheduleTableBody = document.getElementById('scheduleTableBody')
  const scheduleMessage = document.getElementById('scheduleMessage')
  const rangeLabel = document.getElementById('scheduleRangeLabel')
  const viewSelect = document.getElementById('scheduleView')
  const teamFilter = document.getElementById('scheduleTeamFilter')
  const employeeFilter = document.getElementById('scheduleEmployeeFilter')
  const statusFilter = document.getElementById('scheduleStatusFilter')
  const previousButton = document.getElementById('previousScheduleRange')
  const todayButton = document.getElementById('currentScheduleRange')
  const nextButton = document.getElementById('nextScheduleRange')
  const refreshButton = document.getElementById('refreshSchedulesButton')
  const createButton = document.getElementById('createScheduleButton')
  const scheduleForm = document.getElementById('scheduleForm')
  const saveButton = document.getElementById('saveScheduleButton')
  const formMessage = document.getElementById('scheduleFormMessage')
  const restDayInput = document.getElementById('scheduleIsRestDay')
  const holidayInput = document.getElementById('scheduleIsHoliday')
  const repeatWeeklyInput = document.getElementById('scheduleRepeatWeekly')
  const scheduleFrequency = document.getElementById('scheduleFrequency')
  const scheduleToDate = document.getElementById('scheduleToDate')
  const scheduleEndDateLabel = document.getElementById('scheduleEndDateLabel')
  const scheduleDayPicker = document.getElementById('scheduleDayPicker')
  const scheduleDayInputs = [...document.querySelectorAll('input[name="scheduleDay"]')]
  const scheduleCreationSummaryText = document.getElementById('scheduleCreationSummaryText')
  const tablePagination = document.getElementById('scheduleTablePagination')
  const tablePageInfo = document.getElementById('scheduleTablePageInfo')
  const tablePreviousButton = document.getElementById('previousScheduleTablePage')
  const tableNextButton = document.getElementById('nextScheduleTablePage')

  let profiles = []
  let teams = []
  let schedules = []
  let anchorDate = todayInTimeZone('America/New_York')
  let lastFocusedElement = null
  let schedulePage = 1

  const TABLE_PAGE_SIZE = 10

  const STATUS_LABELS = Object.freeze({
    scheduled: 'Scheduled',
    published: 'Published',
    changed: 'Changed',
    cancelled: 'Cancelled',
    completed: 'Completed'
  })

  function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : ''
  }

  function setMessage(element, text, type = '') {
    if (!element) return
    element.textContent = text
    element.className = type ? `wf-message ${type}` : 'wf-message'
  }

  function setLoading(button, loading, loadingText, readyText) {
    if (!button) return
    button.disabled = loading
    button.textContent = loading ? loadingText : readyText
  }

  function errorMessage(error) {
    return error?.message || 'An unexpected error occurred.'
  }

  function parseDateKey(value) {
    const [year, month, day] = value.split('-').map(Number)
    return new Date(Date.UTC(year, month - 1, day))
  }

  function dateKey(date) {
    return date.toISOString().slice(0, 10)
  }

  function addDays(value, amount) {
    const date = parseDateKey(value)
    date.setUTCDate(date.getUTCDate() + amount)
    return dateKey(date)
  }

  function datesInRange(fromDate, toDate) {
    const dates = []
    for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
      dates.push(date)
    }
    return dates
  }

  function scheduleDatesForFrequency(fromDate, toDate) {
    const dates = datesInRange(fromDate, toDate)
    if (scheduleFrequency.value === 'weekdays') {
      return dates.filter(date => {
        const weekday = parseDateKey(date).getUTCDay()
        return weekday >= 1 && weekday <= 5
      })
    }
    if (scheduleFrequency.value === 'custom') {
      const selectedDays = new Set(scheduleDayInputs
        .filter(input => input.checked)
        .map(input => Number(input.value)))
      return dates.filter(date => selectedDays.has(parseDateKey(date).getUTCDay()))
    }
    return scheduleFrequency.value === 'one' ? [fromDate] : dates
  }

  function addMonths(value, amount) {
    const date = parseDateKey(value)
    date.setUTCDate(1)
    date.setUTCMonth(date.getUTCMonth() + amount)
    return dateKey(date)
  }

  function startOfWeek(value) {
    const date = parseDateKey(value)
    const day = date.getUTCDay()
    const mondayOffset = day === 0 ? -6 : 1 - day
    date.setUTCDate(date.getUTCDate() + mondayOffset)
    return dateKey(date)
  }

  function endOfMonth(value) {
    const date = parseDateKey(value)
    date.setUTCMonth(date.getUTCMonth() + 1, 0)
    return dateKey(date)
  }

  function todayInTimeZone(timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date())

    const map = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return `${map.year}-${map.month}-${map.day}`
  }

  function selectedRange() {
    if (viewSelect.value === 'month') {
      const start = `${anchorDate.slice(0, 7)}-01`
      return { start, end: endOfMonth(start) }
    }

    const start = startOfWeek(anchorDate)
    return { start, end: addDays(start, 6) }
  }

  function formatRange({ start, end }) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
    return `${formatter.format(parseDateKey(start))} – ${formatter.format(parseDateKey(end))}`
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).format(parseDateKey(value))
  }

  function formatDateTime(value) {
    if (!value) return '—'
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(value))
  }

  function formatShift(schedule) {
    if (schedule.is_rest_day) return 'Rest day'

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: schedule.timezone || 'America/New_York',
      hour: 'numeric',
      minute: '2-digit'
    })

    return `${formatter.format(new Date(schedule.shift_start))} – ${formatter.format(new Date(schedule.shift_end))}`
  }

  function localTimeInputValue(value, timeZone) {
    if (!value) return ''
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(value))
    const map = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return `${map.hour}:${map.minute}`
  }

  function zoneParts(timestamp, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(timestamp))
    return Object.fromEntries(parts.map(part => [part.type, Number(part.value)]))
  }

  function zonedDateTimeToIso(localValue, timeZone) {
    if (!localValue) return null
    const match = localValue.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/)
    if (!match) throw new Error('Invalid date and time value.')

    const [, year, month, day, hour, minute] = match.map(Number)
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0)

    const calculateOffset = timestamp => {
      const parts = zoneParts(timestamp, timeZone)
      const represented = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second
      )
      return represented - timestamp
    }

    let timestamp = utcGuess - calculateOffset(utcGuess)
    timestamp = utcGuess - calculateOffset(timestamp)
    return new Date(timestamp).toISOString()
  }

  function profileById(userId) {
    return profiles.find(profile => profile.user_id === userId)
  }

  function teamName(teamId) {
    return teams.find(team => team.id === teamId)?.name || 'Unassigned'
  }

  function badge(text, modifier = '') {
    const span = document.createElement('span')
    span.className = modifier ? `wf-badge ${modifier}` : 'wf-badge'
    span.textContent = text
    return span
  }

  function textCell(primary, secondary = '') {
    const cell = document.createElement('td')
    const main = document.createElement('span')
    main.className = 'wf-person'
    main.textContent = primary || '—'
    cell.appendChild(main)

    if (secondary) {
      const sub = document.createElement('span')
      sub.className = 'wf-subtext'
      sub.textContent = secondary
      cell.appendChild(sub)
    }

    return cell
  }

  function statusModifier(status) {
    if (status === 'published' || status === 'completed') return 'success'
    if (status === 'changed' || status === 'scheduled') return 'warning'
    if (status === 'cancelled') return 'danger'
    return 'muted'
  }

  function filteredSchedules() {
    return schedules.filter(schedule => {
      const profile = profileById(schedule.user_id)
      const selectedTeam = teamFilter.value
      const selectedEmployee = employeeFilter.value
      const selectedStatus = statusFilter.value

      return (!selectedTeam || profile?.team_id === selectedTeam) &&
        (!selectedEmployee || schedule.user_id === selectedEmployee) &&
        (!selectedStatus || schedule.status === selectedStatus)
    })
  }

  function renderSummary(rows) {
    document.getElementById('scheduleCount').textContent = rows.length
    document.getElementById('publishedScheduleCount').textContent = rows.filter(item => item.status === 'published').length
    document.getElementById('restDayCount').textContent = rows.filter(item => item.is_rest_day).length
    document.getElementById('holidayCount').textContent = rows.filter(item => item.is_holiday).length
  }

  function renderSchedules() {
    const rows = filteredSchedules()
    scheduleTableBody.replaceChildren()
    renderSummary(rows)

    if (!rows.length) {
      tablePagination.hidden = true
      const row = document.createElement('tr')
      const cell = document.createElement('td')
      cell.colSpan = 8
      cell.className = 'wf-empty'
      cell.textContent = 'No schedule entries match the selected range and filters.'
      row.appendChild(cell)
      scheduleTableBody.appendChild(row)
      return
    }

    const pageCount = Math.ceil(rows.length / TABLE_PAGE_SIZE)
    schedulePage = Math.min(Math.max(schedulePage, 1), pageCount)
    const pageStart = (schedulePage - 1) * TABLE_PAGE_SIZE
    const pageRows = rows.slice(pageStart, pageStart + TABLE_PAGE_SIZE)

    tablePagination.hidden = rows.length <= TABLE_PAGE_SIZE
    tablePageInfo.textContent = `Page ${schedulePage} of ${pageCount}`
    tablePreviousButton.disabled = schedulePage === 1
    tableNextButton.disabled = schedulePage === pageCount

    pageRows.forEach(schedule => {
      const profile = profileById(schedule.user_id)
      const row = document.createElement('tr')
      const typeCell = document.createElement('td')
      const statusCell = document.createElement('td')
      const actionCell = document.createElement('td')
      actionCell.className = 'wf-row-actions'

      if (schedule.is_rest_day) typeCell.appendChild(badge('Rest day', 'muted'))
      else typeCell.appendChild(badge('Shift'))
      if (schedule.is_holiday) typeCell.appendChild(badge(schedule.holiday_name || 'Holiday', 'warning'))

      statusCell.appendChild(badge(
        STATUS_LABELS[schedule.status] || schedule.status,
        statusModifier(schedule.status)
      ))

      const editButton = document.createElement('button')
      editButton.type = 'button'
      editButton.className = 'wf-row-btn'
      editButton.textContent = 'Edit'
      editButton.addEventListener('click', () => openSchedule(schedule.id))
      actionCell.appendChild(editButton)

      const deleteButton = document.createElement('button')
      deleteButton.type = 'button'
      deleteButton.className = 'wf-row-btn danger'
      deleteButton.textContent = 'Delete'
      deleteButton.addEventListener('click', () => deleteSchedule(schedule, deleteButton))
      actionCell.appendChild(deleteButton)

      row.append(
        textCell(formatDate(schedule.shift_date), `Sequence ${schedule.shift_sequence}`),
        textCell(profile?.full_name || 'Unknown employee', profile?.employee_id || ''),
        textCell(teamName(profile?.team_id || schedule.team_id)),
        textCell(formatShift(schedule), schedule.timezone),
        typeCell,
        statusCell,
        textCell(formatDateTime(schedule.updated_at)),
        actionCell
      )
      scheduleTableBody.appendChild(row)
    })
  }

  function populateFilters() {
    const currentTeam = teamFilter.value
    const currentEmployee = employeeFilter.value
    const employeeSelect = document.getElementById('scheduleEmployee')

    teamFilter.replaceChildren(new Option('All teams', ''))
    teams
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(team => teamFilter.appendChild(new Option(
        team.is_active ? team.name : `${team.name} (Inactive)`,
        team.id
      )))

    employeeFilter.replaceChildren(new Option('All employees', ''))
    employeeSelect.replaceChildren(new Option('Select employee', ''))
    profiles
      .filter(profile => profile.is_agent === true && ['active', 'on_leave'].includes(profile.employment_status))
      .sort((a, b) => a.full_name.localeCompare(b.full_name))
      .forEach(profile => {
        const label = `${profile.full_name} — ${profile.employee_id}`
        employeeFilter.appendChild(new Option(label, profile.user_id))
        employeeSelect.appendChild(new Option(label, profile.user_id))
      })

    if ([...teamFilter.options].some(option => option.value === currentTeam)) teamFilter.value = currentTeam
    if ([...employeeFilter.options].some(option => option.value === currentEmployee)) employeeFilter.value = currentEmployee
  }

  function openModal() {
    const modal = document.getElementById('scheduleModal')
    lastFocusedElement = document.activeElement
    modal.hidden = false
    document.body.classList.add('modal-open')
    requestAnimationFrame(() => document.getElementById('scheduleEmployee').focus())
  }

  function closeModal() {
    const modal = document.getElementById('scheduleModal')
    modal.hidden = true
    document.body.classList.remove('modal-open')
    if (lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus()
  }

  function updateScheduleFormState() {
    const isRestDay = restDayInput.checked
    const isHoliday = holidayInput.checked
    const start = document.getElementById('scheduleStart')
    const end = document.getElementById('scheduleEnd')
    const holidayName = document.getElementById('scheduleHolidayName')

    start.disabled = isRestDay
    end.disabled = isRestDay
    start.required = !isRestDay
    end.required = !isRestDay
    if (isRestDay) {
      start.value = ''
      end.value = ''
    }

    holidayName.disabled = !isHoliday
    holidayName.required = isHoliday
    if (!isHoliday) holidayName.value = ''
  }

  function updateScheduleFrequency() {
    const startDate = document.getElementById('scheduleDate').value
    if (!startDate) return
    const mode = scheduleFrequency.value
    const isOneDay = mode === 'one'
    const showDays = mode === 'weekdays' || mode === 'custom'

    if (isOneDay) scheduleToDate.value = startDate
    scheduleToDate.disabled = isOneDay || scheduleFrequency.disabled
    scheduleEndDateLabel.textContent = isOneDay ? 'End Date (same as start)' : 'End Date'
    scheduleDayPicker.hidden = !showDays

    scheduleDayInputs.forEach(input => {
      if (mode === 'weekdays') input.checked = ['1', '2', '3', '4', '5'].includes(input.value)
      input.disabled = mode === 'weekdays' || scheduleFrequency.disabled
    })

    if (mode === 'one') {
      scheduleCreationSummaryText.textContent = 'Creates 1 schedule on the selected date.'
    } else if (mode === 'range') {
      scheduleCreationSummaryText.textContent = 'Creates a schedule for every day in the date range.'
    } else if (mode === 'weekdays') {
      scheduleCreationSummaryText.textContent = 'Creates schedules every Monday–Friday in the date range.'
    } else {
      const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      const selectedNames = scheduleDayInputs.filter(input => input.checked).map(input => names[Number(input.value)])
      scheduleCreationSummaryText.textContent = selectedNames.length
        ? `Creates schedules on ${selectedNames.join(', ')} in the date range.`
        : 'Select at least one day to create schedules on.'
    }
  }

  function resetScheduleForm() {
    scheduleForm.reset()
    document.getElementById('scheduleId').value = ''
    document.getElementById('scheduleModalTitle').textContent = 'Create Schedule'
    document.getElementById('scheduleDate').value = anchorDate
    scheduleToDate.value = anchorDate
    scheduleFrequency.value = 'one'
    document.getElementById('scheduleSequence').value = '1'
    document.getElementById('scheduleTimezone').value = 'America/New_York'
    document.getElementById('scheduleStatus').value = 'published'
    document.getElementById('scheduleEmployee').value = employeeFilter.value || ''
    scheduleFrequency.disabled = false
    setMessage(formMessage, '')
    updateScheduleFormState()
    updateScheduleFrequency()
  }

  function openSchedule(scheduleId = '') {
    resetScheduleForm()
    const schedule = schedules.find(item => item.id === scheduleId)

    if (schedule) {
      document.getElementById('scheduleModalTitle').textContent = 'Edit Schedule Entry'
      document.getElementById('scheduleId').value = schedule.id
      document.getElementById('scheduleEmployee').value = schedule.user_id
      document.getElementById('scheduleDate').value = schedule.shift_date
      scheduleToDate.value = schedule.shift_date
      scheduleFrequency.value = 'one'
      scheduleFrequency.disabled = true
      document.getElementById('scheduleSequence').value = String(schedule.shift_sequence)
      document.getElementById('scheduleTimezone').value = schedule.timezone || 'America/New_York'
      document.getElementById('scheduleStatus').value = schedule.status
      restDayInput.checked = schedule.is_rest_day === true
      holidayInput.checked = schedule.is_holiday === true
      document.getElementById('scheduleHolidayName').value = schedule.holiday_name || ''
      document.getElementById('scheduleNotes').value = schedule.notes || ''
      document.getElementById('scheduleStart').value = localTimeInputValue(schedule.shift_start, schedule.timezone)
      document.getElementById('scheduleEnd').value = localTimeInputValue(schedule.shift_end, schedule.timezone)
      updateScheduleFormState()
      updateScheduleFrequency()
    }

    openModal()
  }

  async function loadScheduleData() {
    schedulePage = 1
    const range = selectedRange()
    rangeLabel.textContent = formatRange(range)
    setLoading(refreshButton, true, 'Refreshing...', 'Refresh')
    setMessage(scheduleMessage, 'Loading schedule entries...')

    try {
      const [profileResult, teamResult, scheduleResult] = await Promise.all([
        supabase
          .from('profiles')
          .select('user_id, full_name, employee_id, employment_status, is_agent, team_id, timezone')
          .order('full_name'),
        supabase
          .from('teams')
          .select('id, name, is_active')
          .order('name'),
        supabase
          .from('work_schedules')
          .select('id, user_id, team_id, shift_date, shift_sequence, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, holiday_name, notes, updated_at')
          .gte('shift_date', range.start)
          .lte('shift_date', range.end)
          .order('shift_date')
          .order('shift_sequence')
      ])

      if (profileResult.error) throw profileResult.error
      if (teamResult.error) throw teamResult.error
      if (scheduleResult.error) throw scheduleResult.error

      profiles = profileResult.data || []
      teams = teamResult.data || []
      schedules = scheduleResult.data || []
      populateFilters()
      renderSchedules()
      setMessage(scheduleMessage, `${schedules.length} schedule entr${schedules.length === 1 ? 'y' : 'ies'} loaded.`)
    } catch (error) {
      schedules = []
      renderSchedules()
      setMessage(scheduleMessage, errorMessage(error), 'error')
    } finally {
      setLoading(refreshButton, false, 'Refreshing...', 'Refresh')
    }
  }

  async function saveSchedule(event) {
    event.preventDefault()

    const scheduleId = document.getElementById('scheduleId').value || null
    const userId = document.getElementById('scheduleEmployee').value
    const shiftDate = document.getElementById('scheduleDate').value
    const toDate = scheduleToDate.value
    const sequence = Number(document.getElementById('scheduleSequence').value)
    const timezone = normalizeText(document.getElementById('scheduleTimezone').value) || 'America/New_York'
    const status = document.getElementById('scheduleStatus').value
    const isRestDay = restDayInput.checked
    const isHoliday = holidayInput.checked
    const holidayName = normalizeText(document.getElementById('scheduleHolidayName').value) || null
    const notes = normalizeText(document.getElementById('scheduleNotes').value) || null
    const repeatWeekly = repeatWeeklyInput.checked
    const sourceDate = shiftDate
    const scheduleDates = scheduleId ? [shiftDate] : scheduleDatesForFrequency(shiftDate, toDate)

    if (!userId || !sourceDate || !Number.isInteger(sequence) || sequence < 1 || sequence > 99) {
      setMessage(formMessage, 'Employee, date, and a shift sequence from 1 to 99 are required.', 'error')
      return
    }

    if (!toDate || toDate < shiftDate) {
      setMessage(formMessage, 'Select an End Date that is on or after the Start Date.', 'error')
      return
    }

    if (scheduleFrequency.value === 'one' && toDate !== shiftDate) {
      setMessage(formMessage, 'One-day schedules must use the same Start Date and End Date.', 'error')
      return
    }

    if (!scheduleDates.length) {
      setMessage(formMessage, 'Select at least one day that falls within the date range.', 'error')
      return
    }

    if (repeatWeekly && scheduleDates.length > 1) {
      setMessage(formMessage, 'Save the selected days first, then enable weekly repetition from a single completed-week entry.', 'error')
      return
    }

    if (isHoliday && !holidayName) {
      setMessage(formMessage, 'Enter the holiday name.', 'error')
      return
    }

    const startTime = document.getElementById('scheduleStart').value
    const endTime = document.getElementById('scheduleEnd').value
    if (!isRestDay && (!startTime || !endTime)) {
      setMessage(formMessage, 'Shift start and end times are required.', 'error')
      return
    }

    setLoading(saveButton, true, 'Saving...', 'Save Schedule')
    setMessage(formMessage, 'Saving schedule entry...')

    try {
      for (const targetDate of scheduleDates) {
        const targetStart = isRestDay
          ? null
          : zonedDateTimeToIso(`${targetDate}T${startTime}`, timezone)
        const targetEndDate = endTime <= startTime ? addDays(targetDate, 1) : targetDate
        const targetEnd = isRestDay
          ? null
          : zonedDateTimeToIso(`${targetEndDate}T${endTime}`, timezone)
        const { error } = await supabase.rpc('workforce_admin_save_schedule_and_repeat', {
          p_schedule_id: scheduleId,
          p_user_id: userId,
          p_shift_date: targetDate,
          p_shift_sequence: sequence,
          p_shift_start: targetStart,
          p_shift_end: targetEnd,
          p_timezone: timezone,
          p_status: status,
          p_is_rest_day: isRestDay,
          p_is_holiday: isHoliday,
          p_holiday_name: holidayName,
          p_notes: notes,
          p_repeat_weekly: repeatWeekly
        })
        if (error) throw error
      }

      setMessage(
        formMessage,
        repeatWeekly
          ? 'Schedule saved and weekly automation enabled.'
          : `${scheduleDates.length} schedule entr${scheduleDates.length === 1 ? 'y' : 'ies'} saved successfully.`,
        'success'
      )
      anchorDate = sourceDate
      await loadScheduleData()
      window.setTimeout(closeModal, 600)
    } catch (error) {
      setMessage(formMessage, errorMessage(error), 'error')
    } finally {
      setLoading(saveButton, false, 'Saving...', 'Save Schedule')
    }
  }

  async function deleteSchedule(schedule, button) {
    const profile = profileById(schedule.user_id)
    const employeeName = profile?.full_name || 'this employee'
    const confirmed = window.confirm(
      `Delete ${employeeName}'s schedule for ${formatDate(schedule.shift_date)}? ` +
      'Linked attendance records will be kept. This cannot be undone.'
    )

    if (!confirmed) return

    setLoading(button, true, 'Deleting...', 'Delete')
    setMessage(scheduleMessage, 'Deleting schedule entry...')

    try {
      const { error } = await supabase.rpc('workforce_admin_delete_schedule', {
        p_schedule_id: schedule.id
      })
      if (error) throw error

      await loadScheduleData()
      setMessage(scheduleMessage, 'Schedule entry deleted successfully.', 'success')
    } catch (error) {
      setMessage(scheduleMessage, errorMessage(error), 'error')
      setLoading(button, false, 'Deleting...', 'Delete')
    }
  }

  async function initialize() {
    const access = await loadCurrentWorkforceAccess(supabase)

    if (!access.authenticated || access.is_admin !== true || !hasWorkforcePermission(access, 'manage_schedules')) {
      section.hidden = true
      return
    }

    document.querySelectorAll('[data-schedule-close]').forEach(button => {
      button.addEventListener('click', closeModal)
    })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeModal()
    })

    previousButton.addEventListener('click', async () => {
      anchorDate = viewSelect.value === 'month' ? addMonths(anchorDate, -1) : addDays(anchorDate, -7)
      await loadScheduleData()
    })
    todayButton.addEventListener('click', async () => {
      anchorDate = todayInTimeZone('America/New_York')
      await loadScheduleData()
    })
    nextButton.addEventListener('click', async () => {
      anchorDate = viewSelect.value === 'month' ? addMonths(anchorDate, 1) : addDays(anchorDate, 7)
      await loadScheduleData()
    })
    refreshButton.addEventListener('click', loadScheduleData)
    createButton.addEventListener('click', () => openSchedule())
    scheduleFrequency.addEventListener('change', updateScheduleFrequency)
    document.getElementById('scheduleDate').addEventListener('change', updateScheduleFrequency)
    scheduleDayInputs.forEach(input => input.addEventListener('change', updateScheduleFrequency))
    viewSelect.addEventListener('change', loadScheduleData)
    teamFilter.addEventListener('change', () => {
      schedulePage = 1
      renderSchedules()
    })
    employeeFilter.addEventListener('change', () => {
      schedulePage = 1
      renderSchedules()
    })
    statusFilter.addEventListener('change', () => {
      schedulePage = 1
      renderSchedules()
    })
    tablePreviousButton.addEventListener('click', () => {
      if (schedulePage <= 1) return
      schedulePage -= 1
      renderSchedules()
    })
    tableNextButton.addEventListener('click', () => {
      schedulePage += 1
      renderSchedules()
    })
    restDayInput.addEventListener('change', updateScheduleFormState)
    holidayInput.addEventListener('change', updateScheduleFormState)
    scheduleForm.addEventListener('submit', saveSchedule)

    await loadScheduleData()
  }

  initialize().catch(error => {
    console.error('Schedule management initialization failed:', error)
    setMessage(scheduleMessage, errorMessage(error), 'error')
  })
}
