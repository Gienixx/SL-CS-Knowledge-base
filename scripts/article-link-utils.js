const WEB_PROTOCOL_PATTERN = /^https?:\/\//i
const EMAIL_PROTOCOL_PATTERN = /^mailto:/i
const RELATIVE_LINK_PATTERN = /^(?:#|\/(?!\/)|\.{1,2}\/)/
const BARE_DOMAIN_PATTERN =
  /^(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:(?!(?:js|md|py|ts|go|rs|cs|sh)(?=[:/?#]|$))[a-z]{2}|com|org|net|edu|gov|info|biz|io|ai|app|dev|me|tech|online|site|support|help|cloud|store|xyz)(?::\d{2,5})?(?:[/?#][^\s]*)?$/i
const INLINE_LINK_PATTERN =
  /\[([^\]\n]+)\]\(([^)\s]+)\)|(?:https?:\/\/|www\.)[^\s<]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:(?!(?:js|md|py|ts|go|rs|cs|sh)(?=[:/?#]|$))[a-z]{2}|com|org|net|edu|gov|info|biz|io|ai|app|dev|me|tech|online|site|support|help|cloud|store|xyz)(?::\d{2,5})?(?:[/?#][^\s<]*)?/gi

export function normalizeArticleLinkHref(value) {
  const candidate = String(value ?? '').trim()

  if (!candidate || /\s/.test(candidate)) {
    return ''
  }

  if (RELATIVE_LINK_PATTERN.test(candidate)) {
    return candidate
  }

  if (EMAIL_PROTOCOL_PATTERN.test(candidate)) {
    const emailAddress = candidate.slice('mailto:'.length)
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)
      ? candidate
      : ''
  }

  const absoluteCandidate =
    WEB_PROTOCOL_PATTERN.test(candidate)
      ? candidate
      : BARE_DOMAIN_PATTERN.test(candidate)
        ? `https://${candidate}`
        : ''

  if (!absoluteCandidate) {
    return ''
  }

  try {
    const url = new URL(absoluteCandidate)

    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname
    ) {
      return ''
    }

    return url.href
  } catch {
    return ''
  }
}

export function isExternalArticleLink(href) {
  return WEB_PROTOCOL_PATTERN.test(String(href ?? ''))
}

function trimTrailingPunctuation(value) {
  let linkText = value
  let trailingText = ''

  while (/[.,!?;:]$/.test(linkText)) {
    trailingText = linkText.slice(-1) + trailingText
    linkText = linkText.slice(0, -1)
  }

  const pairedCharacters = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}']
  ]

  for (const [opening, closing] of pairedCharacters) {
    const openingCount = linkText.split(opening).length - 1
    let closingCount = linkText.split(closing).length - 1

    while (
      linkText.endsWith(closing) &&
      closingCount > openingCount
    ) {
      trailingText = closing + trailingText
      linkText = linkText.slice(0, -1)
      closingCount -= 1
    }
  }

  return { linkText, trailingText }
}

export function findArticleLinks(value) {
  const text = String(value ?? '')
  const links = []
  INLINE_LINK_PATTERN.lastIndex = 0

  for (const match of text.matchAll(INLINE_LINK_PATTERN)) {
    const matchIndex = match.index ?? 0

    if (match[1] !== undefined) {
      const href = normalizeArticleLinkHref(match[2])

      if (href) {
        links.push({
          start: matchIndex,
          end: matchIndex + match[0].length,
          label: match[1],
          href,
          customLabel: true
        })
      }

      continue
    }

    if (text.charAt(matchIndex - 1) === '@') {
      continue
    }

    const { linkText } = trimTrailingPunctuation(match[0])
    const href = normalizeArticleLinkHref(linkText)

    if (href) {
      links.push({
        start: matchIndex,
        end: matchIndex + linkText.length,
        label: linkText,
        href,
        customLabel: false
      })
    }
  }

  return links
}

export function tokenizeArticleLinks(value) {
  const text = String(value ?? '')
  const links = findArticleLinks(text)
  const tokens = []
  let previousIndex = 0

  for (const link of links) {
    if (link.start > previousIndex) {
      tokens.push({
        type: 'text',
        text: text.slice(previousIndex, link.start)
      })
    }

    tokens.push({
      type: 'link',
      label: link.label,
      href: link.href
    })
    previousIndex = link.end
  }

  if (previousIndex < text.length) {
    tokens.push({
      type: 'text',
      text: text.slice(previousIndex)
    })
  }

  return tokens
}
