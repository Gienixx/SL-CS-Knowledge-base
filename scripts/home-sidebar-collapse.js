const STORAGE_KEY = 'socialloop-home-sidebar-collapsed'
const DESKTOP_BREAKPOINT = 820

function initializeSidebarCollapse() {
  const layout = document.querySelector('.home-layout')
  const toggle = document.getElementById('sidebarCollapseToggle')

  if (!layout || !toggle) return

  const updateButton = collapsed => {
    toggle.setAttribute('aria-expanded', String(!collapsed))
    toggle.setAttribute(
      'aria-label',
      collapsed ? 'Expand sidebar' : 'Minimize sidebar'
    )
    toggle.title = collapsed ? 'Expand sidebar' : 'Minimize sidebar'
  }

  const setCollapsed = (collapsed, remember = true) => {
    const desktop = window.innerWidth > DESKTOP_BREAKPOINT
    const appliedState = desktop && collapsed

    layout.classList.toggle('sidebar-collapsed', appliedState)
    updateButton(appliedState)

    if (remember) {
      window.localStorage.setItem(STORAGE_KEY, String(collapsed))
    }
  }

  const savedState = window.localStorage.getItem(STORAGE_KEY) === 'true'
  setCollapsed(savedState, false)

  toggle.addEventListener('click', () => {
    const collapsed = !layout.classList.contains('sidebar-collapsed')
    setCollapsed(collapsed)
  })

  window.addEventListener('resize', () => {
    const preferredState =
      window.localStorage.getItem(STORAGE_KEY) === 'true'

    setCollapsed(preferredState, false)
  })
}

document.addEventListener('DOMContentLoaded', initializeSidebarCollapse)
