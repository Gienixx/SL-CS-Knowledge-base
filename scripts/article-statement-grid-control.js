function getLeadingSpacing(contentInput) {
  const textBeforeCursor = contentInput.value.slice(
    0,
    contentInput.selectionStart
  )

  if (!textBeforeCursor || textBeforeCursor.endsWith('\n\n')) {
    return ''
  }

  if (textBeforeCursor.endsWith('\n')) {
    return '\n'
  }

  return '\n\n'
}

function insertStatementGrid(contentInput) {
  const start = contentInput.selectionStart
  const end = contentInput.selectionEnd
  const selectedText = contentInput.value
    .slice(start, end)
    .trim()
  const title = selectedText || 'Common User Statements'
  const spacing = getLeadingSpacing(contentInput)
  const block =
    `:::statements ${title}\n` +
    'Users may describe the issue in different ways, such as:\n' +
    '- “I was not rewarded for the survey I completed.”\n' +
    '- “I didn’t get the reward for my survey.”\n' +
    '- “I finished the survey but the points were not added.”\n' +
    '- “I completed the offer, but I did not receive my credit.”\n' +
    '- “Where is my reward for the survey?”\n' +
    ':::'
  const replacement = `${spacing}${block}\n\n`
  const currentValue = contentInput.value

  contentInput.value =
    currentValue.slice(0, start) +
    replacement +
    currentValue.slice(end)

  const titleStart =
    start + spacing.length + ':::statements '.length

  contentInput.focus()
  contentInput.setSelectionRange(
    titleStart,
    titleStart + title.length
  )
  contentInput.dispatchEvent(
    new Event('input', { bubbles: true })
  )
}

export function setupStatementGridControl(contentInput) {
  const toolbar = document.querySelector('.format-toolbar')

  if (
    !toolbar ||
    !contentInput ||
    toolbar.querySelector('[data-format="statement-grid"]')
  ) {
    return
  }

  const button = document.createElement('button')
  button.className = 'format-button'
  button.type = 'button'
  button.dataset.format = 'statement-grid'
  button.textContent = 'Statement Grid'
  button.title = 'Insert a two-column user statement card grid'
  button.setAttribute(
    'aria-label',
    'Insert a two-column user statement card grid'
  )

  button.addEventListener('click', event => {
    event.preventDefault()
    event.stopImmediatePropagation()
    insertStatementGrid(contentInput)
  })

  const templateButton = toolbar.querySelector(
    '[data-format="template"]'
  )
  toolbar.insertBefore(button, templateButton)

  const help = document.querySelector('.format-help')

  if (help && !help.querySelector('[data-statement-grid-help]')) {
    const helpText = document.createElement('span')
    helpText.dataset.statementGridHelp = 'true'
    helpText.textContent =
      ' Statement Grid creates responsive quote-style cards.'
    help.appendChild(helpText)
  }
}
