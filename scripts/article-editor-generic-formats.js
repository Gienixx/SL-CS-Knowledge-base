function getSelectedText(input) {
  return input.value.slice(
    input.selectionStart,
    input.selectionEnd
  )
}

function getLeadingSpacing(input) {
  const textBeforeCursor = input.value.slice(
    0,
    input.selectionStart
  )

  if (!textBeforeCursor || textBeforeCursor.endsWith('\n\n')) {
    return ''
  }

  if (textBeforeCursor.endsWith('\n')) {
    return '\n'
  }

  return '\n\n'
}

function replaceSelection(
  input,
  replacement,
  selectionOffset = replacement.length,
  selectionLength = 0
) {
  const start = input.selectionStart
  const end = input.selectionEnd
  const scrollTop = input.scrollTop

  input.value =
    input.value.slice(0, start) +
    replacement +
    input.value.slice(end)

  const selectionStart = start + selectionOffset

  input.focus()
  input.setSelectionRange(
    selectionStart,
    selectionStart + selectionLength
  )
  input.scrollTop = scrollTop
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function insertBlock(
  input,
  block,
  titleOffset = block.length,
  titleLength = 0
) {
  const spacing = getLeadingSpacing(input)

  replaceSelection(
    input,
    `${spacing}${block}\n\n`,
    spacing.length + titleOffset,
    titleLength
  )
}

function getTitle(input, fallback) {
  return getSelectedText(input).trim() || fallback
}

function insertCallout(input) {
  const title = getTitle(input, 'Callout title')
  const block =
    `:::callout ${title}\n\n` +
    'Add important information, a warning, or a note here.\n' +
    ':::'

  insertBlock(input, block, ':::callout '.length, title.length)
}

function insertStepCard(input) {
  const title = getTitle(input, 'Step title')
  const block =
    `:::step ${title}\n\n` +
    'Add the instruction for this step here.\n\n' +
    'Add another supporting detail here if needed.\n' +
    ':::'

  insertBlock(input, block, ':::step '.length, title.length)
}

function insertResponseTemplate(input) {
  const title = getTitle(input, 'Template title')
  const block =
    `:::response-template ${title}\n` +
    'Hi [Recipient Name],\n\n' +
    'Add the response message here.\n\n' +
    'Add any closing message here.\n' +
    ':::'

  insertBlock(
    input,
    block,
    ':::response-template '.length,
    title.length
  )
}

function insertRuleBlock(input, layout) {
  const title = getTitle(input, 'Rules title')
  const directive =
    layout === 'list' ? ':::rules-list ' : ':::rules-grid '
  const block =
    `${directive}${title}\n` +
    'Add a short introduction to the rules here.\n' +
    '1 | Add the first rule here.\n' +
    '2 | Add the second rule here.\n' +
    '3 | Add the third rule here.\n' +
    '4 | Add the fourth rule here.\n' +
    ':::'

  insertBlock(input, block, directive.length, title.length)
}

function insertChecklist(input, layout) {
  const title = getTitle(input, 'Checklist title')
  const directive =
    layout === 'list'
      ? ':::checklist-list '
      : ':::checklist-grid '
  const block =
    `${directive}${title}\n` +
    'Add a short introduction to the checklist here.\n' +
    '- Add the first checklist item here.\n' +
    '- Add the second checklist item here.\n' +
    '- Add the third checklist item here.\n' +
    '- Add the fourth checklist item here.\n' +
    ':::'

  insertBlock(input, block, directive.length, title.length)
}

function insertDecisionTable(input) {
  const firstHeading = 'First column heading'
  const block =
    ':::table\n' +
    `${firstHeading} | Second column heading\n` +
    'First option | Add the result or instruction here.\n' +
    'Second option | Add the result or instruction here.\n' +
    ':::'

  insertBlock(
    input,
    block,
    ':::table\n'.length,
    firstHeading.length
  )
}

function insertStatementGrid(input) {
  const title = getTitle(input, 'Statement section title')
  const block =
    `:::statements ${title}\n` +
    'Add a short introduction to the statements here.\n' +
    '- “Add the first example statement here.”\n' +
    '- “Add the second example statement here.”\n' +
    '- “Add the third example statement here.”\n' +
    '- “Add the fourth example statement here.”\n' +
    ':::'

  insertBlock(input, block, ':::statements '.length, title.length)
}

function insertNumberedGrid(input) {
  const title = getTitle(input, 'Numbered grid title')
  const directive = ':::rules-grid '
  const block =
    `${directive}${title}\n` +
    'Add a short introduction to the numbered items here.\n' +
    '1 | Add the first item here.\n' +
    '2 | Add the second item here.\n' +
    '3 | Add the third item here.\n' +
    '4 | Add the fourth item here.\n' +
    ':::'

  insertBlock(input, block, directive.length, title.length)
}

function insertGenericTemplate(input) {
  const template = `## Section title

Add the section introduction here.

:::step Step title

Add the instruction for this step here.
:::

:::callout Callout title

Add important information, a warning, or a note here.
:::

:::table
First column heading | Second column heading
First option | Add the result or instruction here.
Second option | Add the result or instruction here.
:::

:::rules-grid Rules title
Add a short introduction to the rules here.
1 | Add the first rule here.
2 | Add the second rule here.
:::

:::response-template Template title
Hi [Recipient Name],

Add the response message here.
:::

:::checklist-grid Checklist title
Add a short introduction to the checklist here.
- Add the first checklist item here.
- Add the second checklist item here.
:::`

  const spacing = getLeadingSpacing(input)
  replaceSelection(
    input,
    `${spacing}${template}\n\n`,
    spacing.length,
    template.length
  )
}

function updateNumberedMenu(toolbar) {
  const oldItem = toolbar.querySelector(
    '[data-format="indented-numbered"]'
  )

  if (!oldItem) {
    return
  }

  oldItem.dataset.format = 'numbered-grid'

  const icon = oldItem.querySelector('.toolbar-menu-item-icon')
  const label = oldItem.querySelector(
    '.toolbar-menu-item-icon + span'
  )

  if (icon) {
    icon.textContent = '▦'
  }

  if (label) {
    label.textContent = 'Numbered grid'
  }
}

export function setupGenericArticleFormats({ toolbar, input }) {
  if (
    !toolbar ||
    !input ||
    toolbar.dataset.genericFormatsReady === 'true'
  ) {
    return
  }

  updateNumberedMenu(toolbar)

  const handlers = {
    'numbered-grid': insertNumberedGrid,
    callout: insertCallout,
    'step-card': insertStepCard,
    'response-template': insertResponseTemplate,
    'rule-grid': currentInput => insertRuleBlock(currentInput, 'grid'),
    'rule-list': currentInput => insertRuleBlock(currentInput, 'list'),
    'checklist-grid': currentInput => insertChecklist(currentInput, 'grid'),
    'checklist-list': currentInput => insertChecklist(currentInput, 'list'),
    'decision-table': insertDecisionTable,
    'statement-grid': insertStatementGrid,
    template: insertGenericTemplate
  }

  toolbar.addEventListener(
    'click',
    event => {
      const formatButton = event.target.closest('[data-format]')
      const format = formatButton?.dataset.format
      const handler = handlers[format]

      if (!formatButton || !handler) {
        return
      }

      event.preventDefault()
      event.stopImmediatePropagation()
      handler(input)

      toolbar.querySelectorAll('.toolbar-menu[open]').forEach(menu => {
        menu.removeAttribute('open')
      })
    },
    true
  )

  toolbar.dataset.genericFormatsReady = 'true'
}
