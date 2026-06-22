function createMenuButton(format, icon, label) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'toolbar-menu-item'
  button.dataset.format = format
  button.innerHTML = `
    <span class="toolbar-menu-item-icon" aria-hidden="true">${icon}</span>
    <span>${label}</span>
  `
  return button
}

function createDropdown({ title, icon, items, className = '' }) {
  const details = document.createElement('details')
  details.className = `toolbar-menu ${className}`.trim()

  const summary = document.createElement('summary')
  summary.title = title
  summary.setAttribute('aria-label', title)
  summary.innerHTML = icon

  const panel = document.createElement('div')
  panel.className = 'toolbar-menu-panel'

  for (const item of items) {
    panel.appendChild(
      createMenuButton(item.format, item.icon, item.label)
    )
  }

  details.append(summary, panel)
  return details
}

function closeSiblingMenus(toolbar, currentMenu) {
  toolbar.querySelectorAll('.toolbar-menu[open]').forEach(menu => {
    if (menu !== currentMenu) {
      menu.removeAttribute('open')
    }
  })
}

export function addArticleLayoutControls(toolbar) {
  if (!toolbar || toolbar.dataset.layoutControlsAdded === 'true') {
    return
  }

  const alignMenu = createDropdown({
    title: 'Text alignment',
    icon: '<span aria-hidden="true">≡</span>',
    className: 'align-menu',
    items: [
      { format: 'align-left', icon: '≡', label: 'Align left' },
      { format: 'align-center', icon: '≣', label: 'Align center' },
      { format: 'align-right', icon: '≡', label: 'Align right' },
      { format: 'align-justify', icon: '☰', label: 'Justify' }
    ]
  })

  const indentMenu = createDropdown({
    title: 'Indentation',
    icon: '<span aria-hidden="true">⇥</span>',
    className: 'indent-menu',
    items: [
      {
        format: 'decrease-indent',
        icon: '⇤',
        label: 'Decrease indent'
      },
      {
        format: 'increase-indent',
        icon: '⇥',
        label: 'Increase indent'
      }
    ]
  })

  const specialMenu = toolbar.querySelector('.special-menu')
  const insertionPoint = specialMenu || toolbar.querySelector('.template-icon')

  toolbar.insertBefore(alignMenu, insertionPoint)
  toolbar.insertBefore(indentMenu, insertionPoint)
  toolbar.dataset.layoutControlsAdded = 'true'

  for (const menu of [alignMenu, indentMenu]) {
    menu.addEventListener('toggle', () => {
      if (menu.open) {
        closeSiblingMenus(toolbar, menu)
      }
    })
  }
}
