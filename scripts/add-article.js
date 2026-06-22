import { supabase } from './supabaseClient.js'
import {
  setupArticleEditorPreview
} from './article-editor-preview-v3.js?v=1'

const form = document.getElementById('articleForm')
const message = document.getElementById('message')
const titleInput = document.getElementById('title')
const descriptionInput = document.getElementById('description')
const descriptionCount = document.getElementById('descriptionCount')
const tagInput = document.getElementById('tag')
const contentInput = document.getElementById('content')
const submitButton = form?.querySelector('button[type="submit"]')

let authorInput = null

function updateDescriptionCount() {
  if (!descriptionInput || !descriptionCount) {
    return
  }

  descriptionCount.textContent =
    `${descriptionInput.value.length} / 300`
}

function replaceSelection(
  replacement,
  selectionStartOffset = replacement.length,
  selectionLength = 0
) {
  if (!contentInput) {
    return
  }

  const start = contentInput.selectionStart
  const end = contentInput.selectionEnd
  const currentValue = contentInput.value
  const scrollPosition = contentInput.scrollTop

  contentInput.value =
    currentValue.slice(0, start) +
    replacement +
    currentValue.slice(end)

  const newSelectionStart = start + selectionStartOffset

  contentInput.focus()
  contentInput.setSelectionRange(
    newSelectionStart,
    newSelectionStart + selectionLength
  )
  contentInput.scrollTop = scrollPosition
  contentInput.dispatchEvent(
    new Event('input', { bubbles: true })
  )
}

function getSelectedText() {
  if (!contentInput) {
    return ''
  }

  return contentInput.value.slice(
    contentInput.selectionStart,
    contentInput.selectionEnd
  )
}

function wrapSelectedText(
  openingMarker,
  closingMarker,
  placeholder
) {
  const selectedText = getSelectedText() || placeholder
  const replacement =
    `${openingMarker}${selectedText}${closingMarker}`

  replaceSelection(
    replacement,
    openingMarker.length,
    selectedText.length
  )
}

function getLeadingSpacing() {
  if (!contentInput) {
    return ''
  }

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

function insertHeading(prefix, placeholder) {
  const selectedText = getSelectedText().trim() || placeholder
  const spacing = getLeadingSpacing()
  const replacement =
    `${spacing}${prefix}${selectedText}\n\n`

  replaceSelection(
    replacement,
    spacing.length + prefix.length,
    selectedText.length
  )
}

function prefixSelectedLines(prefixFactory, placeholder) {
  const selectedText = getSelectedText().trim() || placeholder
  const lines = selectedText.split(/\r?\n/)
  const formattedLines = lines.map(
    (line, index) => `${prefixFactory(index)}${line.trim()}`
  )
  const spacing = getLeadingSpacing()

  replaceSelection(
    `${spacing}${formattedLines.join('\n')}\n\n`
  )
}

function insertRichBlock(
  blockText,
  selectionOffset,
  selectionLength
) {
  const spacing = getLeadingSpacing()

  replaceSelection(
    `${spacing}${blockText}\n\n`,
    spacing.length + selectionOffset,
    selectionLength
  )
}

function insertStepCard() {
  const selectedText = getSelectedText().trim()
  const title = selectedText || 'Step title'
  const block =
    `:::step ${title}\n\n` +
    'Write the instructions for this step here.\n\n' +
    'Place the cursor before the closing ::: to insert a nested table, rule grid, checklist, or callout.\n' +
    ':::'

  insertRichBlock(block, ':::step '.length, title.length)
}

function insertCalloutCard() {
  const selectedText = getSelectedText().trim()
  const title = selectedText || 'Important Note'
  const block =
    `:::callout ${title}\n\n` +
    'Write the callout details here.\n\n' +
    'Place the cursor before the closing ::: to insert a nested rule grid or another structured block.\n' +
    ':::'

  insertRichBlock(block, ':::callout '.length, title.length)
}

function insertDecisionTable() {
  const firstHeader = 'User Lifetime Revenue'
  const block =
    ':::table\n' +
    `${firstHeader} | Resolution\n` +
    'Below $100 | Reply using the **Not Rewarded** template only. Do not issue credit.\n' +
    'Above $100 | Reply using the **Not Rewarded** template and issue a credit.\n' +
    ':::'

  insertRichBlock(
    block,
    ':::table\n'.length,
    firstHeader.length
  )
}

function insertRuleGrid() {
  const selectedText = getSelectedText().trim()
  const title = selectedText || 'Credit Rules'
  const block =
    `:::rules ${title}\n` +
    'When issuing credit, follow these limits:\n' +
    "1 | The credit must not exceed the survey's reward amount.\n" +
    '2 | If no survey name is provided, the maximum credit allowed is **up to $1.00 only**.\n' +
    "3 | Credit should only be issued when the user's lifetime revenue is above $100.\n" +
    '4 | Do not issue credit for users below $100 lifetime revenue.\n' +
    ':::'

  insertRichBlock(block, ':::rules '.length, title.length)
}

function insertResponseTemplate() {
  const selectedText = getSelectedText().trim()
  const title =
    selectedText || 'Response condition or audience'
  const block =
    `:::response-template ${title}\n` +
    'Hi [User Name],\n\n' +
    'Thank you for reaching out. Write the recommended response here.\n\n' +
    'Thank you for your understanding.\n' +
    ':::'

  insertRichBlock(
    block,
    ':::response-template '.length,
    title.length
  )
}

function insertChecklist() {
  const selectedText = getSelectedText().trim()
  const title = selectedText || 'Agent Checklist'
  const block =
    `:::checklist ${title}\n` +
    'Before resolving the ticket, confirm the following:\n' +
    '- First checklist item\n' +
    '- Second checklist item\n' +
    '- Third checklist item\n' +
    '- Fourth checklist item\n' +
    ':::'

  insertRichBlock(
    block,
    ':::checklist '.length,
    title.length
  )
}

function insertArticleTemplate() {
  if (!contentInput || !message) {
    return
  }

  const template = `## Overview

Write the article overview here.

:::step Verify the account details

Explain what the agent should check in this step.

:::table
User Lifetime Revenue | Resolution
Below $100 | Add the required resolution.
Above $100 | Add the required resolution.
:::

Add any final instructions for this step.
:::

:::callout Important credit limits

Review these rules before issuing credit.

:::rules Credit Rules
1 | Add the first rule.
2 | Add the second rule.
:::
:::

## Recommended Response Template

:::response-template Response condition or audience
Hi [User Name],

Write the recommended response here.
:::

:::checklist Agent Checklist
Before resolving the ticket, confirm the following:
- First checklist item
- Second checklist item
:::`

  if (!contentInput.value.trim()) {
    contentInput.value = template
  } else {
    const shouldInsert = window.confirm(
      'The editor already contains text. Add the template below the existing content?'
    )

    if (!shouldInsert) {
      return
    }

    contentInput.value =
      `${contentInput.value.trim()}\n\n${template}`
  }

  contentInput.focus()
  contentInput.setSelectionRange(
    contentInput.value.length,
    contentInput.value.length
  )
  contentInput.dispatchEvent(
    new Event('input', { bubbles: true })
  )
  message.textContent = 'Article template inserted.'
}

function applyFormatting(format) {
  switch (format) {
    case 'bold':
      wrapSelectedText('**', '**', 'bold text')
      break
    case 'italic':
      wrapSelectedText('*', '*', 'italic text')
      break
    case 'section':
      insertHeading('## ', 'Section title')
      break
    case 'subheading':
      insertHeading('### ', 'Subheading')
      break
    case 'bullets':
      prefixSelectedLines(() => '- ', 'List item')
      break
    case 'numbered':
      prefixSelectedLines(
        index => `${index + 1}. `,
        'Step description'
      )
      break
    case 'callout':
      insertCalloutCard()
      break
    case 'step-card':
      insertStepCard()
      break
    case 'decision-table':
      insertDecisionTable()
      break
    case 'rule-grid':
      insertRuleGrid()
      break
    case 'response-template':
      insertResponseTemplate()
      break
    case 'checklist':
      insertChecklist()
      break
    case 'template':
      insertArticleTemplate()
      break
    default:
      console.warn(`Unknown formatting option: ${format}`)
  }
}

function createFormatButton(format, label, title) {
  const button = document.createElement('button')
  button.className = 'format-button'
  button.type = 'button'
  button.dataset.format = format
  button.textContent = label
  button.title = title
  button.setAttribute('aria-label', title)
  return button
}

function ensureRichFormattingControls() {
  const toolbar = document.querySelector('.format-toolbar')

  if (!toolbar) {
    return
  }

  const templateButton = toolbar.querySelector(
    '[data-format="template"]'
  )
  const controls = [
    [
      'step-card',
      'Step Card',
      'Insert an automatically numbered step card'
    ],
    [
      'decision-table',
      'Decision Table',
      'Insert a two-column decision table'
    ],
    [
      'rule-grid',
      'Rule Grid',
      'Insert a numbered rule card grid'
    ],
    [
      'response-template',
      'Response Template',
      'Insert a response template card'
    ],
    [
      'checklist',
      'Checklist',
      'Insert a two-column checklist'
    ]
  ]

  for (const [format, label, title] of controls) {
    if (toolbar.querySelector(`[data-format="${format}"]`)) {
      continue
    }

    toolbar.insertBefore(
      createFormatButton(format, label, title),
      templateButton
    )
  }

  const help = document.querySelector('.format-help')

  if (help && !help.querySelector('[data-rich-block-help]')) {
    const helpText = document.createElement('span')
    helpText.dataset.richBlockHelp = 'true'
    helpText.textContent =
      ' Structured blocks can be nested by placing the cursor before the parent block’s closing ::: marker.'
    help.appendChild(helpText)
  }
}

function initializeEditorControls() {
  ensureRichFormattingControls()

  document.querySelectorAll('[data-format]').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault()
      applyFormatting(button.dataset.format)
    })
  })

  contentInput?.addEventListener('keydown', event => {
    const modifierPressed = event.ctrlKey || event.metaKey
    const pressedKey = event.key.toLowerCase()

    if (modifierPressed && pressedKey === 'b') {
      event.preventDefault()
      wrapSelectedText('**', '**', 'bold text')
      return
    }

    if (modifierPressed && pressedKey === 'i') {
      event.preventDefault()
      wrapSelectedText('*', '*', 'italic text')
      return
    }

    if (event.key === 'Tab') {
      event.preventDefault()
      replaceSelection('  ', 2)
    }
  })

  descriptionInput?.addEventListener(
    'input',
    updateDescriptionCount
  )
  updateDescriptionCount()
}

function getErrorMessage(error) {
  if (error && typeof error.message === 'string') {
    return error.message
  }

  return 'An unexpected error occurred.'
}

async function initializeArticleEditor() {
  const previewSetup = setupArticleEditorPreview({
    form,
    titleInput,
    descriptionInput,
    tagInput,
    contentInput
  })

  authorInput = previewSetup.authorInput

  if (
    !form ||
    !message ||
    !submitButton ||
    !titleInput ||
    !descriptionInput ||
    !authorInput ||
    !tagInput ||
    !contentInput
  ) {
    console.error(
      'Required article editor elements were not found.'
    )
    return
  }

  submitButton.disabled = true
  initializeEditorControls()

  try {
    const {
      data: { user },
      error: userError
    } = await supabase.auth.getUser()

    if (userError) {
      throw userError
    }

    if (!user) {
      window.location.replace('./login.html')
      return
    }

    const email = user.email?.trim().toLowerCase()

    if (!email) {
      window.location.replace('./login.html')
      return
    }

    const {
      data: allowedUser,
      error: permissionError
    } = await supabase
      .from('login')
      .select('name, can_edit_articles')
      .ilike('email', email)
      .maybeSingle()

    if (permissionError) {
      throw permissionError
    }

    if (!allowedUser || allowedUser.can_edit_articles !== true) {
      alert('Article editor access only.')
      window.location.replace('./dashboard.html')
      return
    }

    const defaultAuthorName =
      allowedUser.name?.trim() ||
      user.user_metadata?.full_name?.trim() ||
      user.user_metadata?.name?.trim() ||
      email

    if (!authorInput.value.trim()) {
      authorInput.value = defaultAuthorName
      authorInput.defaultValue = defaultAuthorName
      authorInput.dispatchEvent(
        new Event('input', { bubbles: true })
      )
    }

    submitButton.disabled = false
  } catch (error) {
    console.error(
      'Article editor initialization error:',
      error
    )
    message.textContent =
      `Unable to open the article editor: ${getErrorMessage(error)}`
    submitButton.disabled = true
  }
}

initializeArticleEditor()
