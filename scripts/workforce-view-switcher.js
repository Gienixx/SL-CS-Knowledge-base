const views = [
  {
    key: 'workforce',
    button: document.getElementById('workforceViewButton'),
    panel: document.getElementById('workforceView')
  },
  {
    key: 'schedules',
    button: document.getElementById('scheduleViewButton'),
    panel: document.getElementById('scheduleManagementSection')
  },
  {
    key: 'committed-hours',
    button: document.getElementById('committedHoursViewButton'),
    panel: document.getElementById('committedHoursManagementSection')
  }
].filter(view => view.button && view.panel)

function showManagementView(key) {
  views.forEach(view => {
    const active = view.key === key
    view.panel.hidden = !active
    view.button.classList.toggle('active', active)
    view.button.setAttribute('aria-selected', String(active))
    view.button.tabIndex = active ? 0 : -1
  })
}

views.forEach(view => {
  view.button.addEventListener('click', () => showManagementView(view.key))
  view.button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const visibleTabs = views.filter(tab => !tab.button.hidden)
    const currentIndex = visibleTabs.findIndex(tab => tab === view)
    if (currentIndex < 0 || visibleTabs.length < 2) return
    event.preventDefault()
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? visibleTabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + visibleTabs.length) % visibleTabs.length
    const nextTab = visibleTabs[nextIndex]
    showManagementView(nextTab.key)
    nextTab.button.focus()
  })
})
