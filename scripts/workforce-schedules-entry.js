const scheduleModal = document.getElementById('scheduleModal')
const scheduleId = document.getElementById('scheduleId')
const scheduleStatus = document.getElementById('scheduleStatus')

function clarifyScheduleStatuses() {
  const scheduledOption = scheduleStatus?.querySelector('option[value="scheduled"]')
  const publishedOption = scheduleStatus?.querySelector('option[value="published"]')

  if (scheduledOption) {
    scheduledOption.textContent = 'Scheduled (draft — hidden from agents)'
  }

  if (publishedOption) {
    publishedOption.textContent = 'Published (visible to agent)'
  }
}

function defaultNewScheduleToPublished() {
  if (!scheduleModal || scheduleModal.hidden || !scheduleStatus) return

  const isNewSchedule = !scheduleId?.value
  if (isNewSchedule) {
    scheduleStatus.value = 'published'
  }
}

clarifyScheduleStatuses()

if (scheduleModal) {
  new MutationObserver(() => {
    clarifyScheduleStatuses()
    defaultNewScheduleToPublished()
  }).observe(scheduleModal, {
    attributes: true,
    attributeFilter: ['hidden']
  })
}

await import('./workforce-schedules.js?v=9')
