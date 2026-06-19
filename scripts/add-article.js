import { supabase } from './supabaseClient.js'

const form = document.getElementById('articleForm')
const message = document.getElementById('message')

const submitButton =
  form?.querySelector('button[type="submit"]')

const contentInput =
  document.getElementById('content')

const formatButtons =
  document.querySelectorAll('[data-format]')

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

  const placeholderPosition =
    spacing.length + prefix.length

  replaceSelection(
    replacement,
    placeholderPosition,
    selectedText.length
  )
}

function prefixSelectedLines(
  prefixFactory,
  placeholder
) {
  const selectedText =
    getSelectedText().trim() || placeholder

  const lines =
    selectedText.split(/\r?\n/)

  const formattedLines =
    lines.map((line, index) => {
      const cleanLine = line.trim()

      return prefixFactory(index) + cleanLine
    })

  const spacing = getLeadingSpacing()

  const replacement =
    `${spacing}${formattedLines.join('\n')}\n\n`

  replaceSelection(replacement)
}

function insertArticleTemplate() {
  if (!contentInput) {
    return
  }

  const template = `## Overview

Write a short introduction explaining what this article covers.

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

  const existingContent =
    contentInput.value.trim()

  if (!existingContent) {
    contentInput.value = template
  } else {
    const shouldInsert =
      window.confirm(
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

  message.textContent =
    'Article template inserted.'
}

function applyFormatting(format) {
  switch (format) {
    case 'section':
      insertHeading(
        '## ',
        'Section title'
      )
      break

    case 'subheading':
      insertHeading(
        '### ',
        'Subheading'
      )
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

    default:
      console.warn(
        `Unknown formatting option: ${format}`
      )
  }
}

function initializeFormattingToolbar() {
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

      replaceSelection(
        '  ',
        2
      )
    }
  )
}

async function initializeArticleEditor() {
  if (
    !form ||
    !message ||
    !submitButton ||
    !contentInput
  ) {
    console.error(
      'Article editor elements could not be found.'
    )

    return
  }

  initializeFormattingToolbar()

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

    window.location.replace(
      './dashboard.html'
    )

    return
  }

  if (
    !allowedUser ||
    allowedUser.can_edit_articles !== true
  ) {
    alert('Article editor access only.')

    window.location.replace(
      './dashboard.html'
    )

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

      const titleInput =
        document.getElementById('title')

      const tagInput =
        document.getElementById('tag')

      const title =
        titleInput?.value.trim() ?? ''

      const tag =
        tagInput?.value
          .trim()
          .toLowerCase() ?? ''

      const content =
        contentInput.value.trim()

      const validTags = [
        'tickets',
        'cashouts'
      ]

      if (
        !title ||
        !content ||
        !validTags.includes(tag)
      ) {
        message.textContent =
          'Please enter a title, choose a category, and add article content.'

        return
      }

      submitButton.disabled = true
      message.textContent =
        'Saving article...'

      const {
        error: insertError
      } = await supabase
        .from('articles')
        .insert({
          title,
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
    }
  )
}

initializeArticleEditor()
