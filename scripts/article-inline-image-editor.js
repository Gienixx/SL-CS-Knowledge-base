import {
  getSelectedArticleImage,
  removeArticleImage,
  uploadArticleImage
} from './article-image-upload.js?v=2'

function installInlineImageEditorStyles() {
  if (document.getElementById('articleInlineImageEditorStyles')) return

  const style = document.createElement('style')
  style.id = 'articleInlineImageEditorStyles'
  style.textContent = `
    .article-inline-image-dialog {
      width: min(560px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      padding: 0;
      border: 1px solid var(--site-border, rgba(36, 27, 93, 0.14));
      border-radius: 18px;
      color: var(--site-text, var(--sl-text));
      background: var(--site-surface-solid, #fff);
      box-shadow: var(--site-shadow, 0 22px 60px rgba(7, 24, 43, 0.26));
    }

    .article-inline-image-dialog::backdrop {
      background: rgba(3, 15, 29, 0.66);
      backdrop-filter: blur(3px);
    }

    .article-inline-image-form {
      display: grid;
      gap: 15px;
      padding: 24px;
      overflow-y: auto;
    }

    .article-inline-image-heading {
      margin: 0;
      color: var(--site-heading, var(--sl-navy));
      font-size: 1.2rem;
    }

    .article-inline-image-help,
    .article-inline-image-status {
      margin: 0;
      color: var(--site-muted, var(--sl-muted));
      font-size: 0.82rem;
      line-height: 1.5;
    }

    .article-inline-image-status[data-state="error"] {
      color: var(--site-red, #e25d68);
      font-weight: 700;
    }

    .article-inline-image-field {
      display: grid;
      gap: 7px;
    }

    .article-inline-image-field > span {
      color: var(--site-heading, var(--sl-navy));
      font-size: 0.78rem;
      font-weight: 800;
    }

    .article-inline-image-field input,
    .article-inline-image-field select {
      width: 100%;
      min-height: 44px;
      padding: 9px 11px;
      border: 1px solid var(--site-border, rgba(36, 27, 93, 0.16));
      border-radius: 10px;
      color: var(--site-text, var(--sl-text));
      background: var(--site-surface-soft, #f8f6f0);
      font: inherit;
    }

    .article-inline-image-options {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .article-inline-image-preview {
      display: block;
      width: 100%;
      max-height: 230px;
      object-fit: contain;
      border: 1px solid var(--site-border, rgba(36, 27, 93, 0.14));
      border-radius: 12px;
      background: var(--site-surface-soft, #f8f6f0);
    }

    .article-inline-image-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }

    @media (max-width: 560px) {
      .article-inline-image-options {
        grid-template-columns: 1fr;
      }
    }
  `
  document.head.appendChild(style)
}

function cleanInlineImageText(value, fallback = '') {
  const cleaned = String(value || '')
    .replace(/[\]\r\n]+/g, ' ')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || fallback
}

function createField(labelText, control) {
  const label = document.createElement('label')
  label.className = 'article-inline-image-field'
  const text = document.createElement('span')
  text.textContent = labelText
  label.append(text, control)
  return label
}

function createSelect(options) {
  const select = document.createElement('select')
  for (const [value, label] of options) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    select.appendChild(option)
  }
  return select
}

export function setupInlineArticleImagePicker({
  supabase,
  contentInput,
  replaceSelection
}) {
  installInlineImageEditorStyles()

  const dialog = document.createElement('dialog')
  dialog.className = 'article-inline-image-dialog'
  dialog.setAttribute('aria-labelledby', 'inlineArticleImageTitle')

  const form = document.createElement('form')
  form.className = 'article-inline-image-form'
  form.method = 'dialog'

  const heading = document.createElement('h2')
  heading.id = 'inlineArticleImageTitle'
  heading.className = 'article-inline-image-heading'
  heading.textContent = 'Insert article image'

  const help = document.createElement('p')
  help.className = 'article-inline-image-help'
  help.textContent =
    'Upload an image up to 5 MB, then add accessible alternative text and optional display details.'

  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = 'image/jpeg,image/png,image/webp,image/gif'
  fileInput.required = true

  const altInput = document.createElement('input')
  altInput.type = 'text'
  altInput.maxLength = 180
  altInput.placeholder = 'Describe what the image shows'
  altInput.required = true

  const captionInput = document.createElement('input')
  captionInput.type = 'text'
  captionInput.maxLength = 240
  captionInput.placeholder = 'Optional caption shown below the image'

  const alignmentSelect = createSelect([
    ['left', 'Left'],
    ['center', 'Center'],
    ['right', 'Right']
  ])
  alignmentSelect.value = 'center'

  const widthSelect = createSelect([
    ['small', 'Small'],
    ['medium', 'Medium'],
    ['large', 'Large'],
    ['full', 'Full width']
  ])
  widthSelect.value = 'large'

  const options = document.createElement('div')
  options.className = 'article-inline-image-options'
  options.append(
    createField('Alignment', alignmentSelect),
    createField('Display size', widthSelect)
  )

  const preview = document.createElement('img')
  preview.className = 'article-inline-image-preview'
  preview.alt = 'Selected inline image preview'
  preview.hidden = true

  const status = document.createElement('p')
  status.className = 'article-inline-image-status'
  status.setAttribute('aria-live', 'polite')

  const actions = document.createElement('div')
  actions.className = 'article-inline-image-actions'
  const cancelButton = document.createElement('button')
  cancelButton.type = 'button'
  cancelButton.className = 'article-btn secondary'
  cancelButton.textContent = 'Cancel'
  const insertButton = document.createElement('button')
  insertButton.type = 'submit'
  insertButton.className = 'article-btn'
  insertButton.textContent = 'Upload and insert'
  actions.append(cancelButton, insertButton)

  form.append(
    heading,
    help,
    createField('Image file', fileInput),
    createField('Alternative text', altInput),
    createField('Caption', captionInput),
    options,
    preview,
    status,
    actions
  )
  dialog.appendChild(form)
  document.body.appendChild(dialog)

  let objectUrl = ''

  function clearObjectUrl() {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = ''
    preview.hidden = true
    preview.removeAttribute('src')
  }

  function resetDialog() {
    clearObjectUrl()
    form.reset()
    alignmentSelect.value = 'center'
    widthSelect.value = 'large'
    status.textContent = ''
    status.dataset.state = ''
    insertButton.disabled = false
  }

  fileInput.addEventListener('change', () => {
    clearObjectUrl()
    const file = fileInput.files?.[0]
    if (!file) return
    objectUrl = URL.createObjectURL(file)
    preview.src = objectUrl
    preview.hidden = false
  })

  cancelButton.addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => {
    resetDialog()
    contentInput?.focus()
  })

  form.addEventListener('submit', async event => {
    event.preventDefault()
    let uploadedImagePath = ''

    try {
      const file = getSelectedArticleImage(fileInput)
      if (!file || !form.reportValidity()) return

      insertButton.disabled = true
      status.dataset.state = ''
      status.textContent = 'Uploading image…'

      const { data, error } = await supabase.auth.getUser()
      if (error) throw error
      if (!data?.user) throw new Error('Sign in again before uploading an image.')

      const uploaded = await uploadArticleImage({
        supabase,
        file,
        userId: data.user.id
      })
      uploadedImagePath = uploaded.imagePath || ''

      const alt = cleanInlineImageText(altInput.value, 'Article image')
      const caption = cleanInlineImageText(captionInput.value)
      const captionSyntax = caption ? ` "${caption}"` : ''
      const syntax =
        `\n\n![${alt}](${uploaded.imageUrl}${captionSyntax})` +
        `{align=${alignmentSelect.value} width=${widthSelect.value}}\n\n`

      replaceSelection(syntax)
      uploadedImagePath = ''
      dialog.close()
    } catch (error) {
      if (uploadedImagePath) {
        await removeArticleImage({ supabase, imagePath: uploadedImagePath })
      }
      status.dataset.state = 'error'
      status.textContent = error?.message || 'The image could not be uploaded.'
      insertButton.disabled = false
    }
  })

  return {
    open() {
      if (!dialog.open) dialog.showModal()
      fileInput.focus()
    }
  }
}
