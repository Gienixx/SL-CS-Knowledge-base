import { supabase } from './supabaseClient.js?v=9'
import { loadCurrentWorkforceAccess } from './workforce-permissions.js?v=1'

const WORK_TIME_ZONE = 'America/New_York'
const CELEBRATION_LOOKAHEAD_DAYS = 45

document.addEventListener('DOMContentLoaded', initializeDailyOverview)

async function initializeDailyOverview() {
  const todoList = document.getElementById('homeTodoList')
  const celebrationsList = document.getElementById('homeCelebrationsList')

  if (!todoList && !celebrationsList) return

  const today = todayInWorkTimeZone()
  setTodoDate(today)

  try {
    const {
      data: { user },
      error: userError
    } = await supabase.auth.getUser()

    if (userError || !user) throw userError || new Error('Authentication required.')

    const access = await loadCurrentWorkforceAccess(supabase, {
      allowLegacyFallback: false
    })

    if (!access.allowed) throw new Error('Workforce access is unavailable.')

    await Promise.all([
      loadDailyTodos({ user, access, today, todoList }),
      loadCelebrations({ today, celebrationsList })
    ])
  } catch (error) {
    console.error('Home daily overview failed:', error)
    renderPanelError(todoList, 'Unable to load today\'s tasks.')
    renderPanelError(celebrationsList, 'Unable to load celebrations.')
  }
}

async function loadDailyTodos({ user, access, today, todoList }) {
  if (!todoList) return

  const profileIds = Array.isArray(access.linked_profile_ids) && access.linked_profile_ids.length
    ? access.linked_profile_ids
    : [access.user_id].filter(Boolean)
  const assignmentFilter = profileIds.length
    ? `assigned_to.is.null,assigned_to.in.(${profileIds.join(',')})`
    : 'assigned_to.is.null'

  const [{ data: items, error: itemsError }, { data: completions, error: completionsError }] =
    await Promise.all([
      supabase
        .from('home_todo_items')
        .select('id, title, assigned_to')
        .eq('is_active', true)
        .or(assignmentFilter)
        .order('sort_order')
        .order('created_at'),
      supabase
        .from('home_todo_completions')
        .select('todo_item_id')
        .eq('auth_user_id', user.id)
        .eq('completion_date', today)
    ])

  if (itemsError) throw itemsError
  if (completionsError) throw completionsError

  const completedIds = new Set((completions || []).map(row => row.todo_item_id))

  if (!Array.isArray(items) || items.length === 0) {
    todoList.innerHTML = '<p class="lower-panel-empty">No tasks assigned for today.</p>'
    return
  }

  todoList.replaceChildren(...items.map(item => {
    const label = document.createElement('label')
    label.className = 'todo-item'

    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = completedIds.has(item.id)
    checkbox.setAttribute('aria-label', item.title)

    const title = document.createElement('span')
    title.textContent = item.title

    checkbox.addEventListener('change', () => {
      saveTodoCompletion({
        checkbox,
        label,
        itemId: item.id,
        user,
        profileUserId: access.user_id,
        today
      })
    })

    label.append(checkbox, title)
    return label
  }))
}

async function saveTodoCompletion({ checkbox, label, itemId, user, profileUserId, today }) {
  const checked = checkbox.checked
  label.classList.add('is-saving')
  checkbox.disabled = true

  try {
    const query = checked
      ? supabase.from('home_todo_completions').insert({
          todo_item_id: itemId,
          auth_user_id: user.id,
          profile_user_id: profileUserId,
          completion_date: today
        })
      : supabase
          .from('home_todo_completions')
          .delete()
          .eq('todo_item_id', itemId)
          .eq('auth_user_id', user.id)
          .eq('completion_date', today)

    const { error } = await query
    if (error) throw error
  } catch (error) {
    console.error('Unable to save daily task completion:', error)
    checkbox.checked = !checked
  } finally {
    checkbox.disabled = false
    label.classList.remove('is-saving')
  }
}

async function loadCelebrations({ today, celebrationsList }) {
  if (!celebrationsList) return

  const { data, error } = await supabase
    .from('home_celebrations')
    .select('id, display_name, event_type, event_month, event_day, start_year')
    .eq('is_active', true)

  if (error) throw error

  const todayDate = parseDateKey(today)
  const upcoming = (data || [])
    .map(event => ({ ...event, nextDate: nextOccurrence(event, todayDate) }))
    .filter(event => dayDifference(todayDate, event.nextDate) <= CELEBRATION_LOOKAHEAD_DAYS)
    .sort((first, second) => first.nextDate - second.nextDate)

  if (!upcoming.length) {
    celebrationsList.innerHTML = '<p class="lower-panel-empty">No upcoming celebrations.</p>'
    return
  }

  celebrationsList.replaceChildren(...upcoming.map(event => {
    const article = document.createElement('article')
    article.className = 'celebration-item'

    const date = document.createElement('div')
    date.className = 'celebration-date'
    date.innerHTML = `<span>${formatMonth(event.nextDate)}</span><strong>${event.nextDate.getUTCDate()}</strong>`

    const copy = document.createElement('div')
    copy.className = 'celebration-copy'
    const detail = event.event_type === 'anniversary' && event.start_year
      ? `${event.nextDate.getUTCFullYear() - event.start_year} year work anniversary`
      : 'Birthday'
    copy.innerHTML = `<strong>${escapeHtml(event.display_name)}</strong><span>${escapeHtml(detail)}</span>`

    const kind = document.createElement('span')
    kind.className = `celebration-kind ${event.event_type}`
    kind.textContent = event.event_type === 'anniversary' ? 'Anniversary' : 'Birthday'

    article.append(date, copy, kind)
    return article
  }))
}

function nextOccurrence(event, today) {
  let year = today.getUTCFullYear()
  let occurrence = new Date(Date.UTC(year, event.event_month - 1, event.event_day))
  if (occurrence < today) {
    year += 1
    occurrence = new Date(Date.UTC(year, event.event_month - 1, event.event_day))
  }
  return occurrence
}

function todayInWorkTimeZone() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WORK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function setTodoDate(value) {
  const target = document.getElementById('homeTodoDate')
  if (!target) return
  target.textContent = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric'
  }).format(parseDateKey(value))
}

function parseDateKey(value) {
  return new Date(`${value}T00:00:00Z`)
}

function dayDifference(first, second) {
  return Math.round((second - first) / 86400000)
}

function formatMonth(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short'
  }).format(date)
}

function renderPanelError(target, message) {
  if (!target) return
  target.innerHTML = `<p class="lower-panel-empty lower-panel-error">${escapeHtml(message)}</p>`
}

function escapeHtml(value) {
  const element = document.createElement('div')
  element.textContent = String(value)
  return element.innerHTML
}
