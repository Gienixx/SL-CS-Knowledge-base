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
  workforceButton.tabIndex = showSchedules ? -1 : 0
  scheduleButton.tabIndex = showSchedules ? 0 : -1
}

workforceButton?.addEventListener('click', () => showManagementView('workforce'))
scheduleButton?.addEventListener('click', () => showManagementView('schedules'))

function handleTabKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return

  const visibleTabs = [workforceButton, scheduleButton].filter(button => !button.hidden)
  if (visibleTabs.length < 2) return

  event.preventDefault()
  const nextTab = event.currentTarget === workforceButton
    ? scheduleButton
    : workforceButton
  nextTab.click()
  nextTab.focus()
}

workforceButton?.addEventListener('keydown', handleTabKeydown)
scheduleButton?.addEventListener('keydown', handleTabKeydown)
