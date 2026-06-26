const STORAGE_KEY = 'socialloop-home-sidebar-collapsed'
const DESKTOP_BREAKPOINT = 820

function initializeSidebarCollapse() {
  const layout = document.querySelector('.home-layout')
  const sidebar = document.getElementById('homeSidebar')
  const toggle = document.getElementById('sidebarCollapseToggle')
  const backdrop = document.getElementById('sidebarBackdrop')
  const mobileToggle = document.getElementById('sidebarToggle')

  if (!layout || !toggle) return

  const isDesktop = () => window.innerWidth > DESKTOP_BREAKPOINT

  const updateButton = collapsed => {
    if (!isDesktop()) {
      toggle.setAttribute('aria-expanded', 'true')
      toggle.setAttribute('aria-label', 'Close navigation')
      toggle.title = 'Close navigation'
      return
    }

    toggle.setAttribute('aria-expanded', String(!collapsed))
    toggle.setAttribute(
      'aria-label',
      collapsed ? 'Expand sidebar' : 'Minimize sidebar'
    )
    toggle.title = collapsed ? 'Expand sidebar' : 'Minimize sidebar'
  }

  const setCollapsed = (collapsed, remember = true) => {
    const appliedState = isDesktop() && collapsed

    layout.classList.toggle('sidebar-collapsed', appliedState)
    updateButton(appliedState)

    if (remember) {
      window.localStorage.setItem(STORAGE_KEY, String(collapsed))
    }
  }

  const closeMobileSidebar = () => {
    sidebar?.classList.remove('open')
    backdrop?.classList.remove('open')
    mobileToggle?.setAttribute('aria-expanded', 'false')
  }

  const savedState = window.localStorage.getItem(STORAGE_KEY) === 'true'
  setCollapsed(savedState, false)

  toggle.addEventListener('click', () => {
    if (!isDesktop()) {
      closeMobileSidebar()
      return
    }

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
