import { supabase } from './supabaseClient.js'

const form = document.getElementById('articleForm')
const message = document.getElementById('message')

const submitButton =
  form?.querySelector('button[type="submit"]')

const descriptionInput =
  document.getElementById('description')

const descriptionCount =
  document.getElementById('descriptionCount')

const contentInput =
  document.getElementById('content')

const formatButtons =
  document.querySelectorAll('[data-format]')

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

  contentInput.value =
    currentValue.slice(0, start) +
    replacement +
    currentValue.slice(end)

  const selectionStart =
    start + selectionStartOffset

  contentInput.focus()

  contentInput.setSelectionRange(
    selectionStart,
    selectionStart + selectionLength
  )

  contentInput.dispatchEvent(
    new Event('input', {
      bubbles: true
    })
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

function getLeadingSpacing() {
  if (!contentInput) {
    return ''
  }

  const beforeSelection =
    contentInput.value.slice(
      0,
      contentInput.selectionStart
    )

  if (!beforeSelection) {
    return ''
  }

  if (beforeSelection.endsWith('\n\n')) {
    return ''
  }

  if (beforeSelection.endsWith('\n')) {
    return '\n'
  }

  return '\n\n'
}

function insertHeading(prefix, placeholder) {
  const selectedText =
    getSelectedText().trim() || placeholder

  const spacing = getLeadingSpacing()

  const replacement =
    `${spacing}${prefix}${selectedText}\n\n`

  replaceSelection(
    replacement,
    spacing.length + prefix.length,
    selectedText.length
  )
}

function prefixSelectedLines(
  prefixFactory,
  placeholder
) {
  const selectedText =
    getSelectedText().trim() || placeholder

  const formattedLines =
    selectedText
      .split(/\r?\n/)
      .map((line, index) => {
        return prefixFactory(index) + line.trim()
      })

  const spacing = getLeadingSpacing()

  replaceSelection(
    `${spacing}${formattedLines.join('\n')}\n\n`
  )
}

function insertArticleTemplate() {
  if (!contentInput) {
    return
  }

  const template = `## Overview

Write the article overview here.

## Main Process

Explain the main process or workflow here.

### Important Details

Add supporting information under this subheading.

- First important point
- Second important point
- Third important point

## Resolution Steps

1. Complete the first step
2. Complete the second step
3. Complete the third step

> Add an important reminder, warning, or note here.

## Summary

Summarize the key information from the article.`

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

  message.textContent = 'Article template inserted.'
}

function applyFormatting(format) {
  switch (format) {
    case 'section':
      insertHeading('## ', 'Section title')
      break

    case 'subheading':
      insertHeading('### ', 'Subheading')
      break

    case 'bullets':
      prefixSelectedLines(
        () => '- ',
        'List item'
      )
      break

    case 'numbered':
      prefixSelectedLines(
        index => `${index + 1}. `,
        'Step description'
      )
      break

    case 'callout':
      prefixSelectedLines(
        () => '> ',
        'Important note'
      )
      break

    case 'template':
      insertArticleTemplate()
      break
  }
}

function initializeEditorControls() {
  formatButtons.forEach(button => {
    button.addEventListener('click', () => {
      applyFormatting(button.dataset.format)
    })
  })

  contentInput?.addEventListener(
    'keydown',
    event => {
      if (event.key !== 'Tab') {
        return
      }

      event.preventDefault()
      replaceSelection('  ', 2)
    }
  )

  descriptionInput?.addEventListener(
    'input',
    updateDescriptionCount
  )

  updateDescriptionCount()
}

async function initializeArticleEditor() {
  if (
    !form ||
    !message ||
    !submitButton ||
    !descriptionInput ||
    !contentInput
  ) {
    console.error(
      'Article editor elements could not be found.'
    )

    return
  }

  initializeEditorControls()

  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser()

  if (userError) {
    console.error(
      'Authentication error:',
      userError
    )
  }

  if (userError || !user) {
    window.location.replace('./login.html')
    return
  }

  const email =
    user.email?.trim().toLowerCase()

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
    console.error(
      'Permission check error:',
      permissionError
    )

    alert(
      `Unable to verify article editor access: ${permissionError.message}`
    )

    window.location.replace('./dashboard.html')
    return
  }

  if (
    !allowedUser ||
    allowedUser.can_edit_articles !== true
  ) {
    alert('Article editor access only.')
    window.location.replace('./dashboard.html')
    return
  }

  const authorName =
    allowedUser.name?.trim() ||
    user.user_metadata?.full_name?.trim() ||
    user.user_metadata?.name?.trim() ||
    email

  form.addEventListener(
    'submit',
    async event => {
      event.preventDefault()

      const title =
        document
          .getElementById('title')
          ?.value.trim() ?? ''

      const description =
        descriptionInput.value.trim()

      const tag =
        document
          .getElementById('tag')
          ?.value.trim()
          .toLowerCase() ?? ''

      const content =
        contentInput.value.trim()

      const validTags = [
        'tickets',
        'cashouts'
      ]

      if (
        !title ||
        !description ||
        !content ||
        !validTags.includes(tag)
      ) {
        message.textContent =
          'Please enter a title, description, category, and article content.'

        return
      }

      if (description.length > 300) {
        message.textContent =
          'The article description cannot exceed 300 characters.'

        return
      }

      submitButton.disabled = true
      message.textContent = 'Saving article...'

      const {
        error: insertError
      } = await supabase
        .from('articles')
        .insert({
          title,
          description,
          content,
          tag,
          author_name: authorName,
          published: true
        })

      submitButton.disabled = false

      if (insertError) {
        console.error(
          'Article insert error:',
          insertError
        )

        message.textContent =
          `Unable to save article: ${insertError.message}`

        return
      }

      message.textContent =
        'Article saved successfully.'

      form.reset()
      updateDescriptionCount()
    }
  )
}

initializeArticleEditor()
