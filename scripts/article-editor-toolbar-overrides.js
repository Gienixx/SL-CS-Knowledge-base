if (!document.getElementById('articleEditorToolbarOverrides')) {
  const style = document.createElement('style')
  style.id = 'articleEditorToolbarOverrides'
  style.textContent = `
    .editor-shell {
      overflow: visible !important;
    }

    .format-toolbar.grouped-toolbar {
      position: relative;
      z-index: 25;
      border-radius: 14px 14px 0 0;
    }

    .toolbar-menu.special-menu .toolbar-menu-panel {
      right: 0;
      left: auto;
    }

    .content-input {
      position: relative;
      z-index: 1;
      background: rgba(255, 255, 255, 0.96) !important;
    }

    @media (max-width: 700px) {
      .toolbar-menu.special-menu .toolbar-menu-panel {
        right: 16px;
        left: 16px;
      }
    }
  `

  document.head.appendChild(style)
}
