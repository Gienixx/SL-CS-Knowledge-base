const editArticleId = new URLSearchParams(
  window.location.search
).get('edit')

async function waitForPreviewElements() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const form = document.getElementById('articleForm')
    const imageInput = document.getElementById('articleImage')
    const previewCover = document.getElementById('previewCover')

    if (form && imageInput && previewCover) {
      return { form, imageInput, previewCover }
    }

    await new Promise(resolve => window.setTimeout(resolve, 50))
  }

  return null
}

async function preserveExistingImagePreview() {
  if (!editArticleId) {
    return
  }

  const elements = await waitForPreviewElements()

  if (!elements) {
    return
  }

  const {
    form,
    imageInput,
    previewCover
  } = elements

  function restoreExistingImage() {
    queueMicrotask(() => {
      const existingImageUrl =
        form.dataset.existingArticleImageUrl || ''
      const hasReplacementImage = Boolean(imageInput.files?.length)

      if (hasReplacementImage || !existingImageUrl) {
        return
      }

      previewCover.src = existingImageUrl
      previewCover.hidden = false
      previewCover.onerror = () => {
        previewCover.hidden = true
        previewCover.removeAttribute('src')
      }
    })
  }

  for (const input of [
    document.getElementById('title'),
    document.getElementById('description'),
    document.getElementById('author'),
    document.getElementById('tag'),
    document.getElementById('content'),
    imageInput
  ]) {
    input?.addEventListener('input', restoreExistingImage)
    input?.addEventListener('change', restoreExistingImage)
  }

  const observer = new MutationObserver(restoreExistingImage)
  observer.observe(form, {
    attributes: true,
    attributeFilter: ['data-existing-article-image-url']
  })

  restoreExistingImage()
}

queueMicrotask(preserveExistingImagePreview)
