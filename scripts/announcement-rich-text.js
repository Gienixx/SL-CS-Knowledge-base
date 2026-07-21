const ALLOWED_TAGS = new Set([
  'B',
  'BR',
  'DIV',
  'EM',
  'I',
  'LI',
  'OL',
  'P',
  'STRONG',
  'U',
  'UL'
])

const BLOCKED_TAGS = new Set([
  'IFRAME',
  'OBJECT',
  'SCRIPT',
  'STYLE',
  'SVG'
])

export function sanitizeAnnouncementHtml(value) {
  const template = document.createElement('template')
  template.innerHTML = String(value || '').replace(/\r?\n/g, '<br>')

  for (const node of [...template.content.childNodes]) {
    sanitizeNode(node)
  }

  return template.innerHTML
}

export function renderAnnouncementHtml(target, value) {
  if (!target) return
  target.innerHTML = sanitizeAnnouncementHtml(value)
}

export function announcementPlainText(value) {
  const container = document.createElement('div')
  container.innerHTML = sanitizeAnnouncementHtml(value)
  return (container.textContent || '').replace(/\u00a0/g, ' ').trim()
}

function sanitizeNode(node) {
  if (node.nodeType === Node.COMMENT_NODE) {
    node.remove()
    return
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return

  if (BLOCKED_TAGS.has(node.tagName)) {
    node.remove()
    return
  }

  for (const child of [...node.childNodes]) {
    sanitizeNode(child)
  }

  if (!ALLOWED_TAGS.has(node.tagName)) {
    node.replaceWith(...node.childNodes)
    return
  }

  for (const attribute of [...node.attributes]) {
    node.removeAttribute(attribute.name)
  }
}
