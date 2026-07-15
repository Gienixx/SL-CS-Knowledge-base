import {
  loadCurrentWorkforceAccess,
  hasWorkforcePermission
} from './workforce-permissions.js'

function getSupabaseClient() {
  const client = window.__slSupabase

  if (!client) {
    throw new Error('The Supabase client is unavailable.')
  }

  return client
}

function normalizeText(value) {
  return typeof value === 'string'
    ? value.trim()
    : ''
}

function isMissingUpdateColumnError(error) {
  const message = String(error?.message || '').toLowerCase()

  return (
    error?.code === '42703' ||
    error?.code === 'PGRST204' ||
    message.includes('updated_at') ||
    message.includes('updated_by_name')
  )
}

function getEffectiveUpdateDate(article) {
  return article?.updated_at || article?.created_at || ''
}

function getEffectiveUpdater(article) {
  return (
    normalizeText(article?.updated_by_name) ||
    normalizeText(article?.author_name) ||
    'Unknown user'
  )
}

export function formatArticleUpdateDate(value) {
  if (!value) {
    return 'date unavailable'
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return 'date unavailable'
  }

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
}

export function formatArticleUpdateStatus(article) {
  return (
    `Last updated by ${getEffectiveUpdater(article)} · ` +
    formatArticleUpdateDate(getEffectiveUpdateDate(article))
  )
}

function buildArticleQuery({
  includeUpdateColumns,
  articleId,
  publishedOnly
}) {
  const supabase = getSupabaseClient()
  const columns = includeUpdateColumns
    ? 'id, updated_at, updated_by_name, created_at, author_name, published'
    : 'id, created_at, author_name, published'
  let query = supabase
    .from('articles')
    .select(columns)

  if (articleId) {
    query = query.eq('id', articleId)
  }

  if (publishedOnly) {
    query = query.eq('published', true)
  }

  return query
}

export async function loadArticleUpdateMetadata({
  articleId = '',
  publishedOnly = false
} = {}) {
  let result = await buildArticleQuery({
    includeUpdateColumns: true,
    articleId,
    publishedOnly
  })

  if (result.error && isMissingUpdateColumnError(result.error)) {
    result = await buildArticleQuery({
      includeUpdateColumns: false,
      articleId,
      publishedOnly
    })
  }

  if (result.error) {
    throw result.error
  }

  const rows = Array.isArray(result.data) ? result.data : []

  return articleId
    ? rows[0] || null
    : rows
}

export async function getCurrentArticleManager() {
  const supabase = getSupabaseClient()
  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser()

  if (userError) {
    throw userError
  }

  if (!user?.email) {
    return {
      user: null,
      canManageArticles: false,
      displayName: ''
    }
  }

  const email = user.email.trim().toLowerCase()
  const access = await loadCurrentWorkforceAccess(supabase, {
    allowLegacyFallback: false
  })
  const canManageArticles = hasWorkforcePermission(access, 'edit_articles')
  const displayName =
    normalizeText(access.full_name) ||
    normalizeText(user.user_metadata?.full_name) ||
    normalizeText(user.user_metadata?.name) ||
    email

  return {
    user,
    canManageArticles,
    displayName
  }
}
