import { supabase } from './supabaseClient.js'
import {
  setupArticleEditorPreview
} from './article-editor-preview-v3.js?v=2'
import {
  setupGroupedArticleToolbar
} from './article-editor-toolbar.js?v=1'
import { requireWorkforcePermission } from './workforce-permissions.js'

const form = document.getElementById('articleForm')
const message = document.getElementById('message')
const titleInput = document.getElementById('title')
const descriptionInput = document.getElementById('description')
const descriptionCount = document.getElementById('descriptionCount')
const tagInput = document.getElementById('tag')
const contentInput = document.getElementById('content')
const submitButton = form?.querySelector('button[type="submit"]')
const toolbar = document.querySelector('.format-toolbar')

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

function toRoman(number) {
  const values = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i']
  ]

  let remaining = Math.max(1, number)
  let result = ''

  for (const [value, numeral] of values) {
    while (remaining >= value) {
      result += numeral
      remaining -= value
    }
  }

  return result
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
    'Place the cursor before the closing ::: to insert a nested structured block.\n' +
    ':::'

  insertRichBlock(block, ':::step '.length, title.length)
}

function insertCalloutCard() {
  const selectedText = getSelectedText().trim()
  const title = selectedText || 'Important Note'
  const block =
    `:::callout ${title}\n\n` +
    'Write the callout details here.\n\n' +
    'Place the cursor before the closing ::: to insert a nested structured block.\n' +
    ':::'

  insertRichBlock(block, ':::callout '.length, title.length)
}

function insertDecisionTable() {
  const firstHeader = 'User Lifetime Revenue'
  const block =
    ':::table\n' +
    `${firstHeader} | Resolution\n` +
    'Below $100 | Add the required resolution.\n' +
    'Above $100 | Add the required resolution.\n' +
    ':::'

  insertRichBlock(
    block,
    ':::table\n'.length,
    firstHeader.length
  )
}

function insertRuleBlock(layout) {
  const selectedText = getSelectedText().trim()
  const title = selectedText || 'Credit Rules'
  const directive =
    layout === 'list' ? ':::rules-list ' : ':::rules-grid '
  const block =
    `${directive}${title}\n` +
    'When issuing credit, follow these limits:\n' +
    "1 | The credit must not exceed the survey's reward amount.\n" +
    '2 | If no survey name is provided, the maximum credit allowed is **up to $1.00 only**.\n' +
    "3 | Credit should only be issued when the user's lifetime revenue is above $100.\n" +
    '4 | Do not issue credit for users below $100 lifetime revenue.\n' +
    ':::'

  insertRichBlock(block, directive.length, title.length)
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

function insertChecklist(layout) {
  const selectedText = getSelectedText().trim()
  const title = selectedText || 'Agent Checklist'
  const directive =
    layout === 'list'
      ? ':::checklist-list '
      : ':::checklist-grid '
  const block =
    `${directive}${title}\n` +
    'Before resolving the ticket, confirm the following:\n' +
    '- First checklist item\n' +
    '- Second checklist item\n' +
    '- Third checklist item\n' +
    '- Fourth checklist item\n' +
    ':::'

  insertRichBlock(block, directive.length, title.length)
}

function insertStatementGrid() {
  const selectedText = getSelectedText().trim()
  const title = selectedText || 'Common User Statements'
  const block =
    `:::statements ${title}\n` +
    'Users may describe the issue in different ways, such as:\n' +
    '- “I was not rewarded for the survey I completed.”\n' +
    '- “I didn’t get the reward for my survey.”\n' +
    '- “I finished the survey but the points were not added.”\n' +
    '- “I completed the offer, but I did not receive my credit.”\n' +
    '- “Where is my reward for the survey?”\n' +
    ':::'

  insertRichBlock(block, ':::statements '.length, title.length)
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
:::

## Credit Rules

:::rules-grid Credit Rules
When issuing credit, follow these limits:
1 | Add the first rule.
2 | Add the second rule.
:::

## Recommended Response Template

:::response-template Response condition or audience
Hi [User Name],

Write the recommended response here.
:::

:::checklist-grid Agent Checklist
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
    case 'underline':
      wrapSelectedText('++', '++', 'underlined text')
      break
    case 'section':
      insertHeading('## ', 'Section title')
      break
    case 'subheading':
      insertHeading('### ', 'Sub heading')
      break
    case 'bullets':
      prefixSelectedLines(() => '- ', 'List item')
      break
    case 'indented-bullets':
      prefixSelectedLines(() => '  - ', 'Indented list item')
      break
    case 'numbered':
      prefixSelectedLines(
        index => `${index + 1}. `,
        'Numbered item'
      )
      break
    case 'indented-numbered':
      prefixSelectedLines(
        index => `  ${toRoman(index + 1)}. `,
        'Indented numbered item'
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
      insertRuleBlock('grid')
      break
    case 'rule-list':
      insertRuleBlock('list')
      break
    case 'response-template':
      insertResponseTemplate()
      break
    case 'checklist-grid':
      insertChecklist('grid')
      break
    case 'checklist-list':
      insertChecklist('list')
      break
    case 'statement-grid':
      insertStatementGrid()
      break
    case 'template':
      insertArticleTemplate()
      break
    default:
      console.warn(`Unknown formatting option: ${format}`)
  }
}

function initializeEditorControls() {
  setupGroupedArticleToolbar({
    toolbar,
    onFormat: applyFormatting
  })

  contentInput?.addEventListener('keydown', event => {
    const modifierPressed = event.ctrlKey || event.metaKey
    const pressedKey = event.key.toLowerCase()

    if (modifierPressed && pressedKey === 'b') {
      event.preventDefault()
      applyFormatting('bold')
      return
    }

    if (modifierPressed && pressedKey === 'i') {
      event.preventDefault()
      applyFormatting('italic')
      return
    }

    if (modifierPressed && pressedKey === 'u') {
      event.preventDefault()
      applyFormatting('underline')
      return
    }

    if (event.key === 'Tab') {
      event.preventDefault()
      replaceSelection('  ', 2)
    }
  })

  const help = document.querySelector('.format-help')

  if (help) {
    help.innerHTML =
      '<strong>Formatting guide:</strong> Use the icon buttons for text emphasis. Open the grouped menus for headings, lists, checklists, and special article layouts. Place the cursor before a structured block’s closing <strong>:::</strong> to nest another format inside it.'
  }

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
    !contentInput ||
    !toolbar
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

    const access = await requireWorkforcePermission(supabase, 'edit_articles', {
      session: { user },
      returnTo: './add-article.html',
      deniedMessage: 'Article editor access only.'
    })
    if (!access) return

    const email = user.email?.trim().toLowerCase() || ''

    const defaultAuthorName =
      access.full_name?.trim() ||
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
