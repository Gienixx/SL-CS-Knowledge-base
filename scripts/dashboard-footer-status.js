function moveDashboardStatusToFooter() {
  const statusBar = document.querySelector('.dashboard-status-bar')
  const footer = document.querySelector('.phase-one-footer')

  if (!statusBar || !footer) {
    return false
  }

  if (footer.querySelector('.footer-dashboard-status')) {
    statusBar.remove()
    return true
  }

  const statusCopy = statusBar.querySelector('.dashboard-status-copy')
  const statusPill = statusBar.querySelector('.dashboard-status-pill')

  if (!statusCopy) {
    return false
  }

  const footerStatus = document.createElement('span')
  footerStatus.className = 'footer-dashboard-status'

  statusCopy.classList.add('footer-dashboard-status-copy')
  footerStatus.appendChild(statusCopy)

  if (statusPill) {
    footerStatus.appendChild(statusPill)
  }

  const separator = document.createElement('span')
  separator.className = 'footer-source-separator'
  separator.setAttribute('aria-hidden', 'true')
  separator.textContent = '•'

  footer.prepend(separator)
  footer.prepend(footerStatus)
  statusBar.remove()

  return true
}

function initializeFooterStatus() {
  if (moveDashboardStatusToFooter()) {
    return
  }

  const board = document.querySelector('.dashboard-board')

  if (!board) {
    return
  }

  const observer = new MutationObserver(() => {
    if (moveDashboardStatusToFooter()) {
      observer.disconnect()
    }
  })

  observer.observe(document.body, {
    childList: true,
    subtree: true
  })

  window.setTimeout(() => observer.disconnect(), 15000)
}

document.addEventListener('DOMContentLoaded', initializeFooterStatus)
