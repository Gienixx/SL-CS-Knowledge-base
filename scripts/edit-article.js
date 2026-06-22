import { supabase } from './supabaseClient.js'
import {
  getSelectedArticleImage,
  removeArticleImage,
  uploadArticleImage
} from './article-image-upload.js?v=1'

const editArticleId = new URLSearchParams(
  window.location.search
).get('edit')

const form = document.getElementById('articleForm')
const message = document.getElementById('message')
const titleInput = document.getElementById('title')
const descriptionInput = document.getElementById('description')
const tagInput = document.getElementById('tag')
const contentInput = document.getElementById('content')
const submitButton = form?.querySelector('button[type="submit"]')

let currentArticle = null
let editorUser = null

function normalizeEmail(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : ''
}

function getErrorMessage(error) {
  return error && typeof error.message === 'string'
    ? error.message
    : 'An unexpected error occurred.'
}

function isMissingImageColumnError(error) {
  const errorMessage = String(error?.message || '').toLowerCase()

  return (
    error?.code === '42703' ||
    error?.code === 'PGRST204' ||
    errorMessage.includes('image_url')
  )
}

function getArticleImagePath(imageUrl) {
  const rawUrl = String(imageUrl ?? '').trim()

  if (!rawUrl) {
    return ''
  }

  try {
    const url = new URL(rawUrl, document.baseURI)
    const marker = '/storage/v1/object/public/article-images/'
    const markerIndex = url.pathname.indexOf(marker)

    if (markerIndex < 0) {
      return ''
    }

    return decodeURIComponent(
      url.pathname.slice(markerIndex + marker.length)
    )
  } catch {
    return ''
  }
}

function setPageToEditMode() {
  document.title = 'Edit Article | SocialLoop CS Base'

  const heading = document.querySelector('.article-title h1')
  const description = document.querySelector('.article-title p')
  const backLink = document.querySelector('.article-topbar .article-link')

  if (heading) {
    heading.textContent = 'Edit Article'
  }

  if (description) {
    description.textContent =
      'Update the selected knowledge base article and review the changes in the live preview.'
  }

  if (backLink) {
    backLink.href = './article-management.html'
    backLink.textContent = '← Back to Article Management'
  }

  if (submitButton) {
    submitButton.textContent = 'Save Changes'
  }
}

function setExistingImageState(imageUrl) {
  if (!form) {
    return
  }

  const normalizedUrl = String(imageUrl ?? '').trim()
  form.dataset.existingArticleImageUrl = normalizedUrl

  const imageHelp = document.querySelector('.article-image-help')

  if (imageHelp) {
    imageHelp.textContent = normalizedUrl
      ? 'The current image will be retained unless you select a replacement image.'
      : 'No current image. Select a JPEG, PNG, WebP, or GIF image up to 5 MB.'
  }
}

function dispatchEditorUpdates() {
  for (const input of [
    titleInput,
    descriptionInput,
    tagInput,
    contentInput,
    document.getElementById('author'),
    document.getElementById('articleImage')
  ]) {
    input?.dispatchEvent(new Event('input', { bubbles: true }))
    input?.dispatchEvent(new Event('change', { bubbles: true }))
  }
}

async function waitForDynamicEditorFields() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const authorInput = document.getElementById('author')
    const imageInput = document.getElementById('articleImage')

    if (authorInput && imageInput) {
      return { authorInput, imageInput }
    }

    await new Promise(resolve => window.setTimeout(resolve, 50))
  }

  throw new Error('The article editor fields could not be initialized.')
}

async function requireArticleEditorAccess() {
  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser()

  if (userError) {
    throw userError
  }

  if (!user) {
    window.location.replace(
      `./login.html?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`
    )
    return null
  }

  const email = normalizeEmail(user.email)

  if (!email) {
    await supabase.auth.signOut()
    window.location.replace('./login.html')
    return null
  }

  const {
    data: allowedUser,
    error: permissionError
  } = await supabase
    .from('login')
    .select('can_edit_articles')
    .ilike('email', email)
    .maybeSingle()

  if (permissionError) {
    throw permissionError
  }

  if (!allowedUser || allowedUser.can_edit_articles !== true) {
    alert('Article editor access only.')
    window.location.replace('./dashboard.html')
    return null
  }

  return user
}

async function fetchArticle() {
  let result = await supabase
    .from('articles')
    .select(`
      id,
      title,
      description,
      content,
      tag,
      author_name,
      image_url,
      published,
      created_at
    `)
    .eq('id', editArticleId)
    .maybeSingle()

  if (result.error && isMissingImageColumnError(result.error)) {
    result = await supabase
      .from('articles')
      .select(`
        id,
        title,
        description,
        content,
        tag,
        author_name,
        published,
        created_at
      `)
      .eq('id', editArticleId)
      .maybeSingle()
  }

  return result
}

async function initializeEditMode() {
  if (!editArticleId || !form) {
    return
  }

  form.dataset.editMode = 'true'
  form.dataset.editLoading = 'true'
  setPageToEditMode()

  if (submitButton) {
    submitButton.disabled = true
  }

  if (message) {
    message.textContent = 'Loading article...'
  }

  try {
    const { authorInput } = await waitForDynamicEditorFields()
    editorUser = await requireArticleEditorAccess()

    if (!editorUser) {
      return
    }

    const { data: article, error } = await fetchArticle()

    if (error) {
      throw error
    }

    if (!article) {
      throw new Error('The selected article could not be found.')
    }

    currentArticle = article
    titleInput.value = String(article.title ?? '')
    descriptionInput.value = String(article.description ?? '')
    tagInput.value = String(article.tag ?? '').trim().toLowerCase()
    contentInput.value = String(article.content ?? '')
    authorInput.value = String(article.author_name ?? '')
    setExistingImageState(article.image_url)
    dispatchEditorUpdates()

    const descriptionCount = document.getElementById('descriptionCount')

    if (descriptionCount) {
      descriptionCount.textContent =
        `${descriptionInput.value.length} / 300`
    }

    if (message) {
      message.textContent = 'Article loaded. Make your changes and select Save Changes.'
    }

    form.dataset.editLoading = 'false'

    if (submitButton) {
      submitButton.disabled = false
    }
  } catch (error) {
    console.error('Edit article loading error:', error)

    if (message) {
      message.textContent =
        `Unable to load article: ${getErrorMessage(error)}`
    }

    form.dataset.editLoading = 'false'

    if (submitButton) {
      submitButton.disabled = true
    }
  }
}

async function handleEditSubmit(event) {
  if (!editArticleId || !form) {
    return
  }

  event.preventDefault()
  event.stopImmediatePropagation()

  if (form.dataset.editLoading === 'true' || !currentArticle) {
    if (message) {
      message.textContent = 'The article is still loading.'
    }
    return
  }

  if (!form.reportValidity()) {
    return
  }

  const authorInput = document.getElementById('author')
  const imageInput = document.getElementById('articleImage')
  const title = titleInput?.value.trim() || ''
  const description = descriptionInput?.value.trim() || ''
  const authorName = authorInput?.value.trim() || ''
  const tag = tagInput?.value.trim().toLowerCase() || ''
  const content = contentInput?.value.trim() || ''
  const validTags = ['tickets', 'cashouts']

  if (
    !title ||
    !description ||
    !authorName ||
    !content ||
    !validTags.includes(tag)
  ) {
    if (message) {
      message.textContent =
        'Please enter a title, description, author, category, and article content.'
    }
    return
  }

  let uploadedImagePath = ''
  let replacementImageUrl = ''

  try {
    if (submitButton) {
      submitButton.disabled = true
    }

    if (message) {
      message.textContent = 'Saving article changes...'
    }

    if (!editorUser) {
      editorUser = await requireArticleEditorAccess()
    }

    if (!editorUser) {
      return
    }

    const imageFile = getSelectedArticleImage(imageInput)

    if (imageFile) {
      if (message) {
        message.textContent = 'Uploading replacement image...'
      }

      const uploadResult = await uploadArticleImage({
        supabase,
        file: imageFile,
        userId: editorUser.id
      })

      replacementImageUrl = uploadResult.imageUrl || ''
      uploadedImagePath = uploadResult.imagePath || ''
    }

    const articlePayload = {
      title,
      description,
      content,
      tag,
      author_name: authorName,
      published: currentArticle.published !== false
    }

    if (replacementImageUrl) {
      articlePayload.image_url = replacementImageUrl
    }

    const { data: updatedArticle, error: updateError } = await supabase
      .from('articles')
      .update(articlePayload)
      .eq('id', editArticleId)
      .select(`
        id,
        title,
        description,
        content,
        tag,
        author_name,
        image_url,
        published,
        created_at
      `)
      .maybeSingle()

    if (updateError) {
      throw updateError
    }

    if (!updatedArticle) {
      throw new Error('The article could not be updated.')
    }

    const previousImageUrl = String(currentArticle.image_url ?? '')
    currentArticle = updatedArticle

    if (
      replacementImageUrl &&
      previousImageUrl &&
      previousImageUrl !== replacementImageUrl
    ) {
      await removeArticleImage({
        supabase,
        imagePath: getArticleImagePath(previousImageUrl)
      })
    }

    setExistingImageState(updatedArticle.image_url)

    if (imageInput) {
      imageInput.value = ''
    }

    dispatchEditorUpdates()

    if (message) {
      message.textContent = 'Article updated successfully.'
    }
  } catch (error) {
    if (uploadedImagePath) {
      await removeArticleImage({
        supabase,
        imagePath: uploadedImagePath
      })
    }

    console.error('Article update error:', error)

    if (message) {
      message.textContent =
        `Unable to update article: ${getErrorMessage(error)}`
    }
  } finally {
    if (submitButton && form.dataset.editLoading !== 'true') {
      submitButton.disabled = false
    }
  }
}

if (editArticleId && form) {
  form.addEventListener('submit', handleEditSubmit, true)
  queueMicrotask(initializeEditMode)
}
