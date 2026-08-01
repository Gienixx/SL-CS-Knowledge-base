export function getArticleRouteValue(title) {
  return String(title ?? '')
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'article'
}

export function getArticleHref(article) {
  const routeValue = getArticleRouteValue(article?.title)
  return `./KB.html?article=${encodeURIComponent(routeValue)}`
}

export function findArticleByRouteValue(articles, value) {
  const routeValue = String(value ?? '').trim()
  if (!routeValue) return null

  const legacyIdMatch = articles.find(
    article => String(article.id) === routeValue
  )
  if (legacyIdMatch) return legacyIdMatch

  return articles.find(
    article => getArticleRouteValue(article.title) === routeValue.toLowerCase()
  ) || null
}
