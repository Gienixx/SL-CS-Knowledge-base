function installToolbarStyles() {
  if (document.getElementById('groupedArticleToolbarStyles')) {
    return
  }

  const style = document.createElement('style')
  style.id = 'groupedArticleToolbarStyles'
  style.textContent = `
    .format-toolbar.grouped-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 7px;
      padding: 10px;
    }

    .toolbar-divider {
      width: 1px;
      height: 28px;
      margin: 0 2px;
      background: rgba(36, 27, 93, 0.12);
    }

    .toolbar-icon-button,
    .toolbar-menu > summary {
      width: 36px;
      min-width: 36px;
      height: 36px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 1px solid rgba(36, 27, 93, 0.12);
      border-radius: 9px;
      color: var(--sl-navy);
      background: rgba(255, 255, 255, 0.94);
      font: inherit;
      font-size: 0.88rem;
      font-weight: 800;
      line-height: 1;
      cursor: pointer;
      user-select: none;
      transition:
        transform 0.16s ease,
        border-color 0.16s ease,
        background 0.16s ease;
    }

    .toolbar-icon-button:hover,
    .toolbar-menu > summary:hover,
    .toolbar-menu[open] > summary {
      transform: translateY(-1px);
      border-color: rgba(255, 194, 26, 0.7);
      background: rgba(255, 194, 26, 0.12);
    }

    .toolbar-icon-button:focus-visible,
    .toolbar-menu > summary:focus-visible,
    .toolbar-menu-item:focus-visible {
      outline: 3px solid rgba(255, 194, 26, 0.28);
      outline-offset: 2px;
    }

    .toolbar-icon-button u {
      text-underline-offset: 3px;
    }

    .toolbar-icon-button.template-icon {
      margin-left: auto;
      color: #fff;
      border-color: var(--sl-navy);
      background: var(--sl-navy);
    }

    .toolbar-menu {
      position: relative;
    }

    .toolbar-menu > summary {
      list-style: none;
    }

    .toolbar-menu > summary::-webkit-details-marker {
      display: none;
    }

    .toolbar-menu > summary::after {
      content: '';
      position: absolute;
      right: 4px;
      bottom: 4px;
      width: 0;
      height: 0;
      border-left: 3px solid transparent;
      border-right: 3px solid transparent;
      border-top: 4px solid currentColor;
      opacity: 0.7;
    }

    .toolbar-menu-panel {
      position: absolute;
      z-index: 40;
      top: calc(100% + 7px);
      left: 0;
      min-width: 210px;
      display: grid;
      gap: 4px;
      padding: 7px;
      border: 1px solid rgba(36, 27, 93, 0.13);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.99);
      box-shadow: 0 16px 34px rgba(36, 27, 93, 0.15);
    }

    .toolbar-menu.special-menu .toolbar-menu-panel {
      min-width: 250px;
    }

    .toolbar-menu-item {
      width: 100%;
      min-height: 36px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border: 0;
      border-radius: 8px;
      color: var(--sl-text);
      background: transparent;
      font: inherit;
      font-size: 0.82rem;
      font-weight: 650;
      text-align: left;
      cursor: pointer;
    }

    .toolbar-menu-item:hover {
      color: var(--sl-navy);
      background: rgba(255, 194, 26, 0.12);
    }

    .toolbar-menu-item-icon {
      width: 22px;
      display: inline-flex;
      justify-content: center;
      color: var(--sl-navy);
      font-weight: 850;
    }

    .toolbar-menu-separator {
      height: 1px;
      margin: 3px 4px;
      background: rgba(36, 27, 93, 0.09);
    }

    @media (max-width: 700px) {
      .toolbar-icon-button.template-icon {
        margin-left: 0;
      }

      .toolbar-menu-panel {
        position: fixed;
        top: auto;
        right: 16px;
        bottom: 16px;
        left: 16px;
        max-height: 55vh;
        overflow-y: auto;
      }
    }
  `

  document.head.appendChild(style)
}

function createIconButton({ format, icon, title, className = '' }) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `toolbar-icon-button ${className}`.trim()
  button.dataset.format = format
  button.title = title
  button.setAttribute('aria-label', title)
  button.innerHTML = icon
  return button
}

function createMenu({ icon, title, items, className = '' }) {
  const details = document.createElement('details')
  details.className = `toolbar-menu ${className}`.trim()

  const summary = document.createElement('summary')
  summary.title = title
  summary.setAttribute('aria-label', title)
  summary.innerHTML = icon

  const panel = document.createElement('div')
  panel.className = 'toolbar-menu-panel'

  for (const item of items) {
    if (item.separator) {
      const separator = document.createElement('div')
      separator.className = 'toolbar-menu-separator'
      separator.setAttribute('role', 'separator')
      panel.appendChild(separator)
      continue
    }

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'toolbar-menu-item'
    button.dataset.format = item.format
    button.innerHTML = `
      <span class="toolbar-menu-item-icon" aria-hidden="true">${item.icon}</span>
      <span>${item.label}</span>
    `
    panel.appendChild(button)
  }

  details.append(summary, panel)
  return details
}

function closeAllMenus(toolbar, except = null) {
  toolbar.querySelectorAll('.toolbar-menu[open]').forEach(menu => {
    if (menu !== except) {
      menu.removeAttribute('open')
    }
  })
}

export function setupGroupedArticleToolbar({ toolbar, onFormat }) {
  if (!toolbar || typeof onFormat !== 'function') {
    return
  }

  installToolbarStyles()
  toolbar.classList.add('grouped-toolbar')
  toolbar.replaceChildren()

  const boldButton = createIconButton({
    format: 'bold',
    icon: '<strong>B</strong>',
    title: 'Bold selected text'
  })
  const italicButton = createIconButton({
    format: 'italic',
    icon: '<em>I</em>',
    title: 'Italicize selected text'
  })
  const underlineButton = createIconButton({
    format: 'underline',
    icon: '<u>U</u>',
    title: 'Underline selected text'
  })

  const stylesMenu = createMenu({
    icon: '<span aria-hidden="true">¶</span>',
    title: 'Styles',
    items: [
      { format: 'section', icon: 'H1', label: 'Section' },
      { format: 'subheading', icon: 'H2', label: 'Sub heading' }
    ]
  })

  const checklistMenu = createMenu({
    icon: '<span aria-hidden="true">☑</span>',
    title: 'Checklist formats',
    items: [
      { format: 'checklist-grid', icon: '▦', label: 'Checklist (grid)' },
      { format: 'checklist-list', icon: '☷', label: 'Checklist (list)' }
    ]
  })

  const bulletsMenu = createMenu({
    icon: '<span aria-hidden="true">•</span>',
    title: 'Bullet lists',
    items: [
      { format: 'bullets', icon: '•', label: 'Bullets' },
      { format: 'indented-bullets', icon: '◦', label: 'Indented bullets' }
    ]
  })

  const numberedMenu = createMenu({
    icon: '<span aria-hidden="true">1.</span>',
    title: 'Numbered lists',
    items: [
      { format: 'numbered', icon: '1.', label: 'Number list' },
      {
        format: 'indented-numbered',
        icon: 'i.',
        label: 'Indented number list (Roman numerals)'
      }
    ]
  })

  const specialMenu = createMenu({
    icon: '<span aria-hidden="true">✦</span>',
    title: 'Show special formats',
    className: 'special-menu',
    items: [
      { format: 'callout', icon: '!', label: 'Callout' },
      { format: 'step-card', icon: '①', label: 'Step Card' },
      { format: 'response-template', icon: '✉', label: 'Response Template' },
      { separator: true },
      { format: 'rule-grid', icon: '▦', label: 'Rules (grid)' },
      { format: 'rule-list', icon: '☷', label: 'Rules (list)' },
      { format: 'checklist-grid', icon: '▦', label: 'Checklist (grid)' },
      { format: 'checklist-list', icon: '☷', label: 'Checklist (list)' },
      { format: 'decision-table', icon: '▤', label: 'Decision table' },
      { format: 'statement-grid', icon: '❝', label: 'Statement Grid' }
    ]
  })

  const templateButton = createIconButton({
    format: 'template',
    icon: '<span aria-hidden="true">▣</span>',
    title: 'Insert full article template',
    className: 'template-icon'
  })

  const divider = document.createElement('span')
  divider.className = 'toolbar-divider'
  divider.setAttribute('aria-hidden', 'true')

  toolbar.append(
    boldButton,
    italicButton,
    underlineButton,
    divider,
    stylesMenu,
    checklistMenu,
    bulletsMenu,
    numberedMenu,
    specialMenu,
    templateButton
  )

  toolbar.addEventListener('click', event => {
    const formatButton = event.target.closest('[data-format]')

    if (!formatButton || !toolbar.contains(formatButton)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    onFormat(formatButton.dataset.format)
    closeAllMenus(toolbar)
  })

  toolbar.querySelectorAll('.toolbar-menu').forEach(menu => {
    menu.addEventListener('toggle', () => {
      if (menu.open) {
        closeAllMenus(toolbar, menu)
      }
    })
  })

  document.addEventListener('click', event => {
    if (!toolbar.contains(event.target)) {
      closeAllMenus(toolbar)
    }
  })
}
