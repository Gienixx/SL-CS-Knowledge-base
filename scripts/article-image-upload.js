const ARTICLE_IMAGE_BUCKET = 'article-images'
const MAX_IMAGE_SIZE = 5 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
])

function installImageFieldStyles() {
  if (document.getElementById('articleImageFieldStyles')) {
    return
  }

  const style = document.createElement('style')
  style.id = 'articleImageFieldStyles'
  style.textContent = `
    .article-image-field {
      display: grid;
      gap: 10px;
    }

    .article-image-upload {
      position: relative;
      display: grid;
      gap: 10px;
      padding: 16px;
      border: 1px dashed rgba(36, 27, 93, 0.2);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.76);
    }

    .article-image-upload input[type="file"] {
      padding: 10px;
      border: 1px solid rgba(36, 27, 93, 0.1);
      border-radius: 10px;
      background: #fff;
      font-size: 0.9rem;
      cursor: pointer;
    }

    .article-image-help,
    .article-image-status {
      margin: 0;
      color: var(--sl-muted);
      font-size: 0.8rem;
      line-height: 1.5;
    }

    .article-image-status[data-state="error"] {
      color: #a42828;
      font-weight: 650;
    }

    .article-image-preview-shell {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--sl-border);
      border-radius: 12px;
      background: rgba(244, 238, 225, 0.7);
    }

    .article-image-preview {
      display: block;
      width: 100%;
      height: 190px;
      object-fit: cover;
    }

    .article-image-remove {
      position: absolute;
      top: 10px;
      right: 10px;
      min-height: 34px;
      padding: 6px 12px;
      border: 1px solid rgba(255, 255, 255, 0.8);
      border-radius: 999px;
      color: #fff;
      background: rgba(36, 27, 93, 0.9);
      font: inherit;
      font-size: 0.76rem;
      font-weight: 750;
      cursor: pointer;
    }
  `

  document.head.appendChild(style)
}

function validateImageFile(file) {
  if (!file) {
    return ''
  }

  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    return 'Choose a JPEG, PNG, WebP, or GIF image.'
  }

  if (file.size > MAX_IMAGE_SIZE) {
    return 'The article image must be 5 MB or smaller.'
  }

  return ''
}

function getFileExtension(file) {
  const extensionByType = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif'
  }

  return extensionByType[file.type] || 'img'
}

function createUniqueFileName(file, userId) {
  const randomPart =
    globalThis.crypto?.randomUUID?.() ||
    Math.random().toString(36).slice(2)
  const extension = getFileExtension(file)
  const safeUserId = String(userId || 'editor')
    .replace(/[^a-zA-Z0-9_-]/g, '-')

  return `${safeUserId}/${Date.now()}-${randomPart}.${extension}`
}

export function setupArticleImageField({
  form,
  descriptionInput
}) {
  installImageFieldStyles()

  const existingInput = document.getElementById('articleImage')

  if (existingInput) {
    return {
      imageInput: existingInput,
      resetImageField: () => {
        existingInput.value = ''
      }
    }
  }

  const descriptionGroup = descriptionInput?.closest('.field-group')

  if (!form || !descriptionGroup) {
    return {
      imageInput: null,
      resetImageField: () => {}
    }
  }

  const fieldGroup = document.createElement('div')
  fieldGroup.className = 'field-group article-image-field'

  const label = document.createElement('label')
  label.className = 'field-label'
  label.htmlFor = 'articleImage'
  label.textContent = 'Article image (optional)'

  const upload = document.createElement('div')
  upload.className = 'article-image-upload'

  const input = document.createElement('input')
  input.id = 'articleImage'
  input.name = 'articleImage'
  input.type = 'file'
  input.accept = 'image/jpeg,image/png,image/webp,image/gif'

  const help = document.createElement('p')
  help.className = 'article-image-help'
  help.textContent =
    'This image will appear on the article card in the Knowledge Base. JPEG, PNG, WebP, or GIF; maximum 5 MB.'

  const status = document.createElement('p')
  status.className = 'article-image-status'
  status.setAttribute('aria-live', 'polite')

  const previewShell = document.createElement('div')
  previewShell.className = 'article-image-preview-shell'
  previewShell.hidden = true

  const preview = document.createElement('img')
  preview.className = 'article-image-preview'
  preview.alt = 'Selected article image preview'

  const removeButton = document.createElement('button')
  removeButton.className = 'article-image-remove'
  removeButton.type = 'button'
  removeButton.textContent = 'Remove image'

  previewShell.append(preview, removeButton)
  upload.append(input, help, status, previewShell)
  fieldGroup.append(label, upload)
  descriptionGroup.insertAdjacentElement('afterend', fieldGroup)

  let objectUrl = ''

  function clearPreview() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = ''
    }

    preview.removeAttribute('src')
    previewShell.hidden = true
    status.textContent = ''
    status.dataset.state = ''
    input.setCustomValidity('')
  }

  function resetImageField() {
    input.value = ''
    clearPreview()
  }

  input.addEventListener('change', () => {
    clearPreview()
    const file = input.files?.[0]
    const validationMessage = validateImageFile(file)

    if (validationMessage) {
      input.setCustomValidity(validationMessage)
      status.textContent = validationMessage
      status.dataset.state = 'error'
      input.reportValidity()
      return
    }

    if (!file) {
      return
    }

    objectUrl = URL.createObjectURL(file)
    preview.src = objectUrl
    previewShell.hidden = false
    status.textContent = `${file.name} selected.`
  })

  removeButton.addEventListener('click', resetImageField)

  return {
    imageInput: input,
    resetImageField
  }
}

export function getSelectedArticleImage(imageInput) {
  const file = imageInput?.files?.[0] || null
  const validationMessage = validateImageFile(file)

  if (validationMessage) {
    throw new Error(validationMessage)
  }

  return file
}

export async function uploadArticleImage({
  supabase,
  file,
  userId
}) {
  const validationMessage = validateImageFile(file)

  if (validationMessage) {
    throw new Error(validationMessage)
  }

  if (!file) {
    return {
      imageUrl: null,
      imagePath: null
    }
  }

  const imagePath = createUniqueFileName(file, userId)
  const { error: uploadError } = await supabase.storage
    .from(ARTICLE_IMAGE_BUCKET)
    .upload(imagePath, file, {
      cacheControl: '3600',
      contentType: file.type,
      upsert: false
    })

  if (uploadError) {
    throw uploadError
  }

  const { data } = supabase.storage
    .from(ARTICLE_IMAGE_BUCKET)
    .getPublicUrl(imagePath)

  const imageUrl = data?.publicUrl || null

  if (!imageUrl) {
    await removeArticleImage({ supabase, imagePath })
    throw new Error('The image uploaded, but its public URL could not be created.')
  }

  return {
    imageUrl,
    imagePath
  }
}

export async function removeArticleImage({
  supabase,
  imagePath
}) {
  if (!imagePath) {
    return
  }

  const { error } = await supabase.storage
    .from(ARTICLE_IMAGE_BUCKET)
    .remove([imagePath])

  if (error) {
    console.warn('Unable to remove unused article image:', error)
  }
}
