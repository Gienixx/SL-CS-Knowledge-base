import { supabase } from './supabaseClient.js'
import {
  setupArticleEditorPreview
} from './article-editor-preview.js?v=1'

const form = document.getElementById('articleForm')
const message = document.getElementById('message')
const titleInput = document.getElementById('title')
const descriptionInput = document.getElementById('description')
const descriptionCount = document.getElementById('descriptionCount')
const tagInput = document.getElementById('tag')
const contentInput = document.getElementById('content')
const submitButton = form?.querySelector('button[type="submit"]')

let authorInput = null
let renderPreview = () => {}

function updateDescriptionCount() {
  if (!descriptionInput || !descriptionCount) {
    return
  }

  descriptionCount.textContent = `${descriptionInput.value.length} / 300`
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
  contentInput.dispatchEvent(new Event('input', { bubbles: true }))
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

function wrapSelectedText(openingMarker, closingMarker, placeholder) {
  if (!contentInput) {
    return
  }

  const selectedText = getSelectedText() || placeholder
  const replacement = `${openingMarker}${selectedText}${closingMarker}`

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
  const replacement = `${spacing}${prefix}${selectedText}\n\n`

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

  replaceSelection(`${spacing}${formattedLines.join('\n')}\n\n`)
}

function insertStepCard() {
  if (!contentInput) {
    return
  }

  const selectedText = getSelectedText().trim()
  const title = selectedText || 'Step title'
  const spacing = getLeadingSpacing()
  const replacement =
    `${spacing}:::step ${title}\n\n` +
    'Write the instructions for this step here.\n\n' +
    'Add another paragraph or supporting detail if needed.\n' +
    ':::\n\n'

  replaceSelection(
    replacement,
    spacing.length + ':::step '.length,
    title.length
  )
}

function insertArticleTemplate() {
  if (!contentInput || !message) {
    return
  }

  const template = `## Overview

Write the article overview here.

:::step First step title

Explain what the agent should check or complete in this step.
:::

:::step Second step title

Explain the next action and include any important details.
:::

## Resolution

Summarize the final outcome or resolution.

> Add an important reminder, warning, or note here.`

  if (!contentInput.value.trim()) {
    contentInput.value = template
  } else {
    const shouldInsert = window.confirm(
      'The editor already contains text. Add the template below the existing content?'
    )

    if (!shouldInsert) {
      return
    }

    contentInput.value = `${contentInput.value.trim()}\n\n${template}`
  }

  contentInput.focus()
  contentInput.setSelectionRange(
    contentInput.value.length,
    contentInput.value.length
  )
  contentInput.dispatchEvent(new Event('input', { bubbles: true }))
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
      prefixSelectedLines(index => `${index + 1}. `, 'Step description')
      break
    case 'callout':
      prefixSelectedLines(() => '> ', 'Important note')
      break
    case 'step-card':
      insertStepCard()
      break
    case 'template':
      insertArticleTemplate()
      break
    default:
      console.warn(`Unknown formatting option: ${format}`)
  }
}

function ensureStepCardControl() {
  const toolbar = document.querySelector('.format-toolbar')

  if (!toolbar || toolbar.querySelector('[data-format="step-card"]')) {
    return
  }

  const button = document.createElement('button')
  button.className = 'format-button'
  button.type = 'button'
  button.dataset.format = 'step-card'
  button.textContent = 'Step Card'
  button.title = 'Insert an automatically numbered step card'
  button.setAttribute(
    'aria-label',
    'Insert an automatically numbered step card'
  )

  const templateButton = toolbar.querySelector('[data-format="template"]')
  toolbar.insertBefore(button, templateButton)

  const help = document.querySelector('.format-help')

  if (help && !help.querySelector('[data-step-card-help]')) {
    const helpText = document.createElement('span')
    helpText.dataset.stepCardHelp = 'true'
    helpText.textContent =
      ' Step Card creates an automatically numbered process card.'
    help.appendChild(helpText)
  }
}

function initializeEditorControls() {
  ensureStepCardControl()

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

  descriptionInput?.addEventListener('input', updateDescriptionCount)
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
  renderPreview = previewSetup.renderPreview

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
    console.error('Required article editor elements were not found.')
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

    form.addEventListener('submit', async event => {
      event.preventDefault()

      const title = titleInput.value.trim()
      const description = descriptionInput.value.trim()
      const authorName = authorInput.value.trim()
      const tag = tagInput.value.trim().toLowerCase()
      const content = contentInput.value.trim()
      const validTags = ['tickets', 'cashouts']

      if (
        !title ||
        !description ||
        !authorName ||
        !content ||
        !validTags.includes(tag)
      ) {
        message.textContent =
          'Please enter a title, description, author, category, and article content.'
        return
      }

      if (description.length > 300) {
        message.textContent =
          'The article description cannot exceed 300 characters.'
        return
      }

      submitButton.disabled = true
      message.textContent = 'Saving article...'

      try {
        const { error: insertError } = await supabase
          .from('articles')
          .insert({
            title,
            description,
            content,
            tag,
            author_name: authorName,
            published: true
          })

        if (insertError) {
          throw insertError
        }

        form.reset()
        updateDescriptionCount()
        renderPreview()
        message.textContent = 'Article saved successfully.'
      } catch (error) {
        console.error('Article insert error:', error)
        message.textContent =
          `Unable to save article: ${getErrorMessage(error)}`
      } finally {
        submitButton.disabled = false
      }
    })
  } catch (error) {
    console.error('Article editor initialization error:', error)
    message.textContent =
      `Unable to open the article editor: ${getErrorMessage(error)}`
    submitButton.disabled = true
  }
}

initializeArticleEditor()
