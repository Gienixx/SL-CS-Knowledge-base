import { renderAnnouncementHtml } from '../scripts/announcement-rich-text.js?v=2'

export const IMPORTANT_ANNOUNCEMENT_STORAGE_PREFIX = 'sl-important-announcements-shown:'

export function isEligibleAnnouncement(row, now = Date.now()) {
  if (row?.status !== 'published') return false
  if (row.deleted_at || row.is_deleted === true || row.is_active === false) return false
  const expiration = row.expires_at || row.expiration_at
  return !expiration || Date.parse(expiration) > now
}

export function activeImportantAnnouncements(rows, now = Date.now()) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row?.is_important === true && isEligibleAnnouncement(row, now))
    .sort((left, right) => {
      const leftDate = Date.parse(left.published_at || left.created_at || '') || 0
      const rightDate = Date.parse(right.published_at || right.created_at || '') || 0
      return rightDate - leftDate || String(right.id || '').localeCompare(String(left.id || ''))
    })
    .slice(0, 2)
}

export function eligibleImportantAnnouncementCount(rows, excludeId = null, now = Date.now()) {
  return (Array.isArray(rows) ? rows : []).filter(row =>
    row?.id !== excludeId &&
    row?.is_important === true &&
    isEligibleAnnouncement(row, now)
  ).length
}

function decodeJwtPayload(accessToken) {
  try {
    const encoded = String(accessToken || '').split('.')[1]
    if (!encoded) return null
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    return JSON.parse(globalThis.atob(padded))
  } catch {
    return null
  }
}

export function sessionAnnouncementKey(session) {
  const payload = decodeJwtPayload(session?.access_token)
  if (payload?.session_id) return payload.session_id

  const userId = session?.user?.id || ''
  const loginMarker = session?.user?.last_sign_in_at || payload?.iat || ''
  if (userId && loginMarker) return `${userId}:${loginMarker}`

  return session?.refresh_token || userId
}

export function importantAnnouncementStorageKey(session) {
  return `${IMPORTANT_ANNOUNCEMENT_STORAGE_PREFIX}${sessionAnnouncementKey(session)}`
}

export function importantAnnouncementNavigation(index, count) {
  const lastIndex = Math.max(0, count - 1)
  return {
    index: Math.min(Math.max(index, 0), lastIndex),
    showNavigation: count > 1,
    backDisabled: index <= 0,
    nextLabel: index >= lastIndex ? 'Done' : 'Next'
  }
}

export function nextImportantAnnouncementIndex(index, direction, count) {
  return importantAnnouncementNavigation(index + direction, count).index
}

async function loadImportantAnnouncements(supabase) {
  const { data, error } = await supabase
    .from('team_announcements')
    .select('id, title, body, category, status, is_important, published_by_name, published_at, created_at')
    .eq('status', 'published')
    .eq('is_important', true)
    .order('published_at', { ascending: false })
    .order('id', { ascending: false })

  if (error) throw error
  return activeImportantAnnouncements(data)
}

function readShown(storageKey) {
  try {
    return window.localStorage.getItem(storageKey) === 'shown'
  } catch {
    return false
  }
}

function markShown(storageKey) {
  try {
    window.localStorage.setItem(storageKey, 'shown')
  } catch {
    // The in-memory initialization guard still prevents duplicate opens on
    // the current page when browser storage is unavailable.
  }
}

function formatAnnouncementDate(value) {
  const date = new Date(value || '')
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date)
}

function ensurePopupStyles() {
  if (document.querySelector('link[data-important-announcement-styles]')) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = './styles/important-announcement-popup.css?v=2'
  link.dataset.importantAnnouncementStyles = 'true'
  document.head.append(link)
}

function createPopup(announcements) {
  ensurePopupStyles()

  const dialog = document.createElement('dialog')
  dialog.id = 'importantAnnouncementDialog'
  dialog.className = 'important-announcement-dialog'
  dialog.setAttribute('aria-labelledby', 'importantAnnouncementTitle')

  const card = document.createElement('div')
  card.className = 'important-announcement-card'

  const header = document.createElement('div')
  header.className = 'important-announcement-header'

  const badge = document.createElement('span')
  badge.className = 'important-announcement-badge'
  badge.textContent = 'Important'

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'important-announcement-close'
  close.setAttribute('aria-label', 'Close announcement')
  close.textContent = '×'
  close.addEventListener('click', () => dialog.close())
  header.append(badge, close)

  const title = document.createElement('h2')
  title.id = 'importantAnnouncementTitle'

  const meta = document.createElement('p')
  meta.className = 'important-announcement-meta'

  const body = document.createElement('div')
  body.className = 'important-announcement-body'

  const footer = document.createElement('div')
  footer.className = 'important-announcement-footer'
  const indicator = document.createElement('span')
  indicator.className = 'important-announcement-indicator'
  const controls = document.createElement('div')
  controls.className = 'important-announcement-controls'
  const gotIt = document.createElement('button')
  gotIt.type = 'button'
  gotIt.className = 'secondary-button'
  gotIt.textContent = 'Got it'
  gotIt.addEventListener('click', () => dialog.close())
  const back = document.createElement('button')
  back.type = 'button'
  back.className = 'secondary-button'
  back.textContent = 'Back'
  const next = document.createElement('button')
  next.type = 'button'
  next.className = 'primary-button'
  controls.append(gotIt, back, next)
  footer.append(indicator, controls)

  card.append(header, title, meta, body, footer)
  dialog.append(card)
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close()
  })

  let index = 0
  const render = () => {
    const announcement = announcements[index]
    const navigation = importantAnnouncementNavigation(index, announcements.length)
    index = navigation.index
    title.textContent = announcement.title || 'Important announcement'
    const details = [
      announcement.category || 'General',
      formatAnnouncementDate(announcement.published_at || announcement.created_at),
      announcement.published_by_name ? `Published by ${announcement.published_by_name}` : ''
    ].filter(Boolean)
    meta.textContent = details.join(' · ')
    renderAnnouncementHtml(body, announcement.body || '')
    indicator.textContent = announcements.length > 1
      ? `${index + 1} of ${announcements.length}`
      : ''
    indicator.hidden = !navigation.showNavigation
    back.hidden = !navigation.showNavigation
    next.hidden = !navigation.showNavigation
    back.disabled = navigation.backDisabled
    next.textContent = navigation.nextLabel
  }

  back.addEventListener('click', () => {
    index = nextImportantAnnouncementIndex(index, -1, announcements.length)
    render()
  })
  next.addEventListener('click', () => {
    if (index >= announcements.length - 1) {
      dialog.close()
      return
    }
    index = nextImportantAnnouncementIndex(index, 1, announcements.length)
    render()
  })

  render()
  return dialog
}

export async function initializeImportantAnnouncementPopup(supabase) {
  if (typeof window === 'undefined' || !supabase) return
  if (window.__slImportantAnnouncementPopupInitialized) return
  window.__slImportantAnnouncementPopupInitialized = true

  if (/\/login\.html$/i.test(window.location.pathname)) return

  const run = async () => {
    const { data, error } = await supabase.auth.getSession()
    if (error || !data?.session?.user) return

    const session = data.session
    const storageKey = importantAnnouncementStorageKey(session)
    if (readShown(storageKey)) return

    let announcements
    try {
      announcements = await loadImportantAnnouncements(supabase)
    } catch (requestError) {
      console.warn('Unable to load Important announcements:', requestError)
      return
    }

    markShown(storageKey)
    if (!announcements.length || !document.body) return
    document.body.append(createPopup(announcements))
    document.getElementById('importantAnnouncementDialog')?.showModal()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void run(), { once: true })
  } else {
    await run()
  }
}
