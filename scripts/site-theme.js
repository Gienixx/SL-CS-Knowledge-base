(() => {
  const STORAGE_KEY = 'socialloop-site-theme'
  const THEMES = new Set(['light', 'dark'])
  const root = document.documentElement

  function storedTheme() {
    try {
      const value = window.localStorage.getItem(STORAGE_KEY)
      return THEMES.has(value) ? value : null
    } catch {
      return null
    }
  }

  function currentTheme() {
    return THEMES.has(root.dataset.siteTheme)
      ? root.dataset.siteTheme
      : storedTheme() || 'light'
  }

  function updateControls(theme) {
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      const selected = button.dataset.themeChoice === theme
      button.classList.toggle('active', selected)
      button.setAttribute('aria-pressed', String(selected))
    })

    const attendanceToggle = document.getElementById('attendanceThemeToggle')
    if (attendanceToggle) {
      attendanceToggle.checked = theme === 'light'
      attendanceToggle.setAttribute(
        'aria-label',
        theme === 'light' ? 'Use dark website theme' : 'Use light website theme'
      )
    }
  }

  function setTheme(theme, { persist = true } = {}) {
    const nextTheme = THEMES.has(theme) ? theme : 'light'
    root.dataset.siteTheme = nextTheme
    root.style.colorScheme = nextTheme

    if (persist) {
      try {
        window.localStorage.setItem(STORAGE_KEY, nextTheme)
      } catch {
        // The preference still applies to the current page when storage is unavailable.
      }
    }

    updateControls(nextTheme)
    window.dispatchEvent(new CustomEvent('site-theme-change', {
      detail: { theme: nextTheme }
    }))
  }

  setTheme(storedTheme() || 'light', { persist: false })

  window.SocialLoopTheme = Object.freeze({
    get: currentTheme,
    set: setTheme,
    toggle: () => setTheme(currentTheme() === 'light' ? 'dark' : 'light')
  })

  document.addEventListener('DOMContentLoaded', () => {
    const settingsButton = document.getElementById('siteSettingsButton')
    const settingsMenu = document.getElementById('siteSettingsMenu')
    const attendanceToggle = document.getElementById('attendanceThemeToggle')

    const closeSettings = ({ restoreFocus = false } = {}) => {
      if (!settingsButton || !settingsMenu) return
      settingsMenu.hidden = true
      settingsButton.setAttribute('aria-expanded', 'false')
      if (restoreFocus) settingsButton.focus()
    }

    const openSettings = () => {
      if (!settingsButton || !settingsMenu) return
      settingsMenu.hidden = false
      settingsButton.setAttribute('aria-expanded', 'true')
      settingsMenu.querySelector(`[data-theme-choice="${currentTheme()}"]`)?.focus()
    }

    settingsButton?.addEventListener('click', event => {
      event.stopPropagation()
      if (settingsMenu?.hidden) openSettings()
      else closeSettings()
    })

    settingsMenu?.addEventListener('click', event => {
      event.stopPropagation()
      const choice = event.target.closest('[data-theme-choice]')
      if (!choice) return
      setTheme(choice.dataset.themeChoice)
      closeSettings({ restoreFocus: true })
    })

    attendanceToggle?.addEventListener('change', () => {
      setTheme(attendanceToggle.checked ? 'light' : 'dark')
    })

    document.addEventListener('click', () => closeSettings())
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && settingsMenu && !settingsMenu.hidden) {
        closeSettings({ restoreFocus: true })
      }
    })

    updateControls(currentTheme())
  })
})()
