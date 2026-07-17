const workforceButton = document.getElementById('workforceViewButton')
const scheduleButton = document.getElementById('scheduleViewButton')
const workforceView = document.getElementById('workforceView')
const scheduleView = document.getElementById('scheduleManagementSection')

function showManagementView(view) {
  const showSchedules = view === 'schedules'
  workforceView.hidden = showSchedules
  scheduleView.hidden = !showSchedules
  workforceButton.classList.toggle('active', !showSchedules)
  scheduleButton.classList.toggle('active', showSchedules)
  workforceButton.setAttribute('aria-selected', String(!showSchedules))
  scheduleButton.setAttribute('aria-selected', String(showSchedules))
}

workforceButton?.addEventListener('click', () => showManagementView('workforce'))
scheduleButton?.addEventListener('click', () => showManagementView('schedules'))
