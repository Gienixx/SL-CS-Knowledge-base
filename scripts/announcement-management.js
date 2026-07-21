import { supabase } from './supabaseClient.js?v=8'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'
import {
  announcementPlainText,
  renderAnnouncementHtml,
  sanitizeAnnouncementHtml
} from './announcement-rich-text.js?v=1'

const state = {
  access: null,
  announcements: [],
  editingId: null,
  saving: false,
  profiles: [],
  todos: [],
  todoEditingId: null,
  todoSaving: false,
  todoActivityLogs: []
}

const elements = {}

document.addEventListener('DOMContentLoaded', initializeAnnouncementManagement)

async function initializeAnnouncementManagement() {
  collectElements()
  installEvents()

  try {
    const { data, error } = await supabase.auth.getSession()

    if (error) throw error
    if (!data.session) {
      window.location.replace('./login.html')
      return
    }

    const access = await loadCurrentWorkforceAccess(supabase, {
      session: data.session,
      allowLegacyFallback: false
    })

    const canManageAnnouncements = access.allowed && (
      access.is_admin === true ||
      hasWorkforcePermission(access, 'manage_announcements')
    )

    if (!canManageAnnouncements) {
      window.alert('You do not have permission to manage website announcements.')
      window.location.replace('./home.html')
      return
    }

    state.access = access
    configureWebsiteManagementAccess()

    const managementLoaders = [loadAnnouncements()]
    if (access.is_admin === true) {
      managementLoaders.push(loadTodoManagement(), loadTodoActivityLogs())
    }

    const [announcementResult, todoResult, todoLogResult] = await Promise.allSettled(
      managementLoaders
    )

    if (announcementResult.status === 'rejected') {
      console.error('Unable to load announcements:', announcementResult.reason)
      renderListState('Announcements could not be loaded.', true)
    }

    if (todoResult?.status === 'rejected') {
      console.error('Unable to load assigned tasks:', todoResult.reason)
      renderTodoListState('Assigned tasks could not be loaded.', true)
    }

    if (todoLogResult?.status === 'rejected') {
      console.error('Unable to load task activity:', todoLogResult.reason)
      renderTodoActivityState('Task activity could not be loaded.', true)
    }

    activateInitialTab()
    elements.page.setAttribute('aria-busy', 'false')
  } catch (error) {
    console.error('Unable to initialize Website Management:', error)
    setFormStatus('Announcement management access could not be verified. Return to Home and try again.', 'error')
    renderListState('Announcements could not be loaded.', true)
    renderTodoListState('Assigned tasks could not be loaded.', true)
    renderTodoActivityState('Task activity could not be loaded.', true)
  }
}

function collectElements() {
  elements.page = document.getElementById('announcementManagementPage')
  elements.form = document.getElementById('announcementForm')
  elements.title = document.getElementById('announcementTitle')
  elements.category = document.getElementById('announcementCategory')
  elements.body = document.getElementById('announcementBody')
  elements.messageEditor = document.getElementById('announcementMessageEditor')
  elements.formatButtons = [...document.querySelectorAll('[data-format-command]')]
  elements.characterCount = document.getElementById('announcementCharacterCount')
  elements.formStatus = document.getElementById('announcementFormStatus')
  elements.saveDraft = document.getElementById('announcementSaveDraft')
  elements.publish = document.getElementById('announcementPublish')
  elements.cancelEdit = document.getElementById('announcementCancelEdit')
  elements.editorTitle = document.getElementById('announcementEditorTitle')
  elements.editorHint = document.getElementById('announcementEditorHint')
  elements.list = document.getElementById('announcementList')
  elements.count = document.getElementById('announcementCount')
  elements.announcementTab = document.getElementById('announcementManagementTab')
  elements.todoTab = document.getElementById('todoManagementTab')
  elements.announcementPanel = document.getElementById('announcementManagementPanel')
  elements.todoPanel = document.getElementById('todoManagementPanel')
  elements.todoForm = document.getElementById('todoForm')
  elements.todoAssignee = document.getElementById('todoAssignee')
  elements.todoAssigneeCount = document.getElementById('todoAssigneeCount')
  elements.todoSelectAll = document.getElementById('todoSelectAll')
  elements.todoClearSelection = document.getElementById('todoClearSelection')
  elements.todoTitle = document.getElementById('todoTitle')
  elements.todoSortOrder = document.getElementById('todoSortOrder')
  elements.todoIsActive = document.getElementById('todoIsActive')
  elements.todoFormStatus = document.getElementById('todoFormStatus')
  elements.todoSave = document.getElementById('todoSave')
  elements.todoCancelEdit = document.getElementById('todoCancelEdit')
  elements.todoEditorTitle = document.getElementById('todoEditorTitle')
  elements.todoEditorHint = document.getElementById('todoEditorHint')
  elements.todoUserFilter = document.getElementById('todoUserFilter')
  elements.todoList = document.getElementById('todoManagementList')
  elements.todoCount = document.getElementById('todoCount')
  elements.todoActivityLogBody = document.getElementById('todoActivityLogBody')
  elements.todoActivityLogCount = document.getElementById('todoActivityLogCount')
  elements.todoActivityLogRefresh = document.getElementById('todoActivityLogRefresh')
}

function installEvents() {
  elements.form.addEventListener('submit', handleSubmit)
  elements.messageEditor.addEventListener('input', updateCharacterCount)
  elements.messageEditor.addEventListener('paste', handleMessagePaste)
  elements.cancelEdit.addEventListener('click', resetEditor)
  elements.list.addEventListener('click', handleListAction)
  elements.announcementTab.addEventListener('click', () => setActiveTab('announcements'))
  elements.todoTab.addEventListener('click', () => setActiveTab('todos'))
  elements.todoForm.addEventListener('submit', handleTodoSubmit)
  elements.todoCancelEdit.addEventListener('click', resetTodoEditor)
  elements.todoSelectAll.addEventListener('click', selectAllTodoAssignees)
  elements.todoClearSelection.addEventListener('click', clearTodoAssignees)
  elements.todoUserFilter.addEventListener('change', renderTodos)
  elements.todoList.addEventListener('click', handleTodoListAction)
  elements.todoActivityLogRefresh.addEventListener('click', refreshTodoActivityLogs)

  for (const button of elements.formatButtons) {
    button.addEventListener('mousedown', event => event.preventDefault())
    button.addEventListener('click', applyMessageFormat)
  }

  for (const tab of [elements.announcementTab, elements.todoTab]) {
    tab.addEventListener('keydown', handleTabKeydown)
  }
}

function configureWebsiteManagementAccess() {
  const isAdmin = state.access?.is_admin === true
  elements.todoTab.hidden = !isAdmin
  elements.todoPanel.hidden = true
}

function activateInitialTab() {
  const requestedTab = state.access?.is_admin === true && window.location.hash === '#todos'
    ? 'todos'
    : 'announcements'
  setActiveTab(requestedTab, false)
}

function setActiveTab(tabName, updateHash = true) {
  const showTodos = state.access?.is_admin === true && tabName === 'todos'
  elements.announcementTab.classList.toggle('active', !showTodos)
  elements.todoTab.classList.toggle('active', showTodos)
  elements.announcementTab.setAttribute('aria-selected', String(!showTodos))
  elements.todoTab.setAttribute('aria-selected', String(showTodos))
  elements.announcementTab.tabIndex = showTodos ? -1 : 0
  elements.todoTab.tabIndex = showTodos ? 0 : -1
  elements.announcementPanel.hidden = showTodos
  elements.todoPanel.hidden = !showTodos

  if (updateHash) {
    window.history.replaceState(null, '', showTodos ? '#todos' : '#announcements')
  }
}

function handleTabKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  const nextTab = event.currentTarget === elements.announcementTab
    ? elements.todoTab
    : elements.announcementTab
  nextTab.click()
  nextTab.focus()
}

async function loadAnnouncements() {
  const { data, error } = await supabase
    .from('team_announcements')
    .select('id, title, body, category, status, created_by_name, published_by_name, published_at, created_at, updated_at')
    .order('created_at', { ascending: false })

  if (error) throw error

  state.announcements = Array.isArray(data) ? data : []
  renderAnnouncements()
}

async function loadTodoManagement() {
  const [profilesResult, todosResult] = await Promise.all([
    supabase
      .from('profiles')
      .select('user_id, full_name, email, employee_id, employment_status')
      .in('employment_status', ['active', 'on_leave'])
      .order('full_name'),
    supabase
      .from('home_todo_items')
      .select('id, title, assigned_to, sort_order, is_active, created_at, updated_at')
      .order('sort_order')
      .order('created_at')
  ])

  if (profilesResult.error) throw profilesResult.error
  if (todosResult.error) throw todosResult.error

  state.profiles = Array.isArray(profilesResult.data) ? profilesResult.data : []
  state.todos = Array.isArray(todosResult.data) ? todosResult.data : []
  populateProfileOptions()
  renderTodos()
}

async function loadTodoActivityLogs() {
  const { data, error } = await supabase
    .from('home_todo_activity_logs')
    .select('id, task_title, agent_name, action, completion_date, occurred_at')
    .order('occurred_at', { ascending: false })
    .limit(100)

  if (error) throw error
  state.todoActivityLogs = Array.isArray(data) ? data : []
  renderTodoActivityLogs()
}

async function refreshTodoActivityLogs() {
  elements.todoActivityLogRefresh.disabled = true
  elements.todoActivityLogRefresh.textContent = 'Refreshing...'

  try {
    await loadTodoActivityLogs()
  } catch (error) {
    console.error('Unable to refresh task activity:', error)
    renderTodoActivityState(error.message || 'Task activity could not be loaded.', true)
  } finally {
    elements.todoActivityLogRefresh.disabled = false
    elements.todoActivityLogRefresh.textContent = 'Refresh log'
  }
}

function renderTodoActivityLogs() {
  elements.todoActivityLogBody.replaceChildren()
  elements.todoActivityLogCount.textContent = String(state.todoActivityLogs.length)

  if (!state.todoActivityLogs.length) {
    renderTodoActivityState('No checkbox activity has been recorded yet.')
    return
  }

  for (const entry of state.todoActivityLogs) {
    const row = document.createElement('tr')
    row.append(
      createTodoLogCell(formatTodoLogTimestamp(entry.occurred_at), 'todo-log-timestamp'),
      createTodoLogCell(entry.task_title),
      createTodoLogCell(entry.agent_name),
      createTodoLogActionCell(entry.action)
    )
    elements.todoActivityLogBody.appendChild(row)
  }
}

function createTodoLogCell(value, className = '') {
  const cell = document.createElement('td')
  cell.textContent = value || '-'
  cell.className = className
  return cell
}

function createTodoLogActionCell(action) {
  const cell = document.createElement('td')
  const badge = document.createElement('span')
  const checked = action === 'checked'
  badge.className = `todo-log-action ${checked ? 'checked' : 'unchecked'}`
  badge.textContent = checked ? 'Checked' : 'Unchecked'
  cell.appendChild(badge)
  return cell
}

function renderTodoActivityState(message, isError = false) {
  elements.todoActivityLogBody.replaceChildren()
  elements.todoActivityLogCount.textContent = '0'
  const row = document.createElement('tr')
  const cell = document.createElement('td')
  cell.colSpan = 4
  cell.className = `todo-log-empty${isError ? ' error' : ''}`
  cell.textContent = message
  row.appendChild(cell)
  elements.todoActivityLogBody.appendChild(row)
}

function formatTodoLogTimestamp(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown time'

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  }).format(date)
}

function populateProfileOptions() {
  const selectedAssignees = new Set(selectedTodoAssigneeIds())
  const filterValue = elements.todoUserFilter.value
  elements.todoAssignee.replaceChildren()
  elements.todoUserFilter.replaceChildren(new Option('All team members', ''))

  for (const profile of state.profiles) {
    const label = profileLabel(profile)
    elements.todoAssignee.appendChild(createTodoAssigneeOption(profile, selectedAssignees))
    elements.todoUserFilter.appendChild(new Option(label, profile.user_id))
  }

  if (!state.profiles.length) {
    const empty = document.createElement('p')
    empty.className = 'member-picker-empty'
    empty.textContent = 'No active team members are available.'
    elements.todoAssignee.appendChild(empty)
  }

  if (state.profiles.some(profile => profile.user_id === filterValue)) {
    elements.todoUserFilter.value = filterValue
  }

  updateTodoAssigneeCount()
}

function createTodoAssigneeOption(profile, selectedAssignees) {
  const label = document.createElement('label')
  label.className = 'todo-assignee-option'

  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.value = profile.user_id
  checkbox.checked = selectedAssignees.has(profile.user_id)
  checkbox.addEventListener('change', updateTodoAssigneeCount)

  const name = document.createElement('span')
  name.textContent = profileLabel(profile)
  label.append(checkbox, name)
  return label
}

function selectedTodoAssigneeIds() {
  return [...elements.todoAssignee.querySelectorAll('input[type="checkbox"]:checked')]
    .map(input => input.value)
}

function setTodoAssigneeSelection(userIds) {
  const selected = new Set(userIds.filter(Boolean))
  elements.todoAssignee.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.checked = selected.has(input.value)
  })
  updateTodoAssigneeCount()
}

function selectAllTodoAssignees() {
  elements.todoAssignee.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.checked = true
  })
  updateTodoAssigneeCount()
}

function clearTodoAssignees() {
  setTodoAssigneeSelection([])
}

function updateTodoAssigneeCount() {
  const count = selectedTodoAssigneeIds().length
  elements.todoAssigneeCount.textContent = `${count} selected`
}

async function handleTodoSubmit(event) {
  event.preventDefault()
  if (state.todoSaving || !state.access) return

  const title = elements.todoTitle.value.trim()
  const assignedTo = selectedTodoAssigneeIds()
  const sortOrder = Math.max(0, Math.min(9999, Number(elements.todoSortOrder.value) || 0))

  if (!assignedTo.length || !title) {
    setTodoFormStatus('Select at least one team member and enter a task.', 'error')
    return
  }

  const payload = {
    title,
    sort_order: sortOrder,
    is_active: elements.todoIsActive.checked,
    updated_at: new Date().toISOString()
  }

  const wasEditing = Boolean(state.todoEditingId)
  setTodoSaving(true)
  setTodoFormStatus(state.todoEditingId ? 'Saving task changes...' : 'Assigning task...')

  try {
    let error = null

    if (state.todoEditingId) {
      const [primaryAssignee, ...additionalAssignees] = assignedTo
      const updateResult = await supabase
        .from('home_todo_items')
        .update({
          ...payload,
          assigned_to: primaryAssignee
        })
        .eq('id', state.todoEditingId)

      error = updateResult.error

      if (!error && additionalAssignees.length) {
        const insertResult = await supabase
          .from('home_todo_items')
          .insert(additionalAssignees.map(assignedToId => ({
            ...payload,
            assigned_to: assignedToId,
            created_by: state.access.user_id
          })))
        error = insertResult.error
      }
    } else {
      const insertResult = await supabase
        .from('home_todo_items')
        .insert(assignedTo.map(assignedToId => ({
          ...payload,
          assigned_to: assignedToId,
          created_by: state.access.user_id
        })))
      error = insertResult.error
    }

    if (error) throw error

    resetTodoEditor()
    await reloadTodos()
    setTodoFormStatus(
      wasEditing
        ? assignedTo.length > 1
          ? `Task updated and copied to ${assignedTo.length - 1} additional team member${assignedTo.length === 2 ? '' : 's'}.`
          : 'Task updated.'
        : `Task assigned to ${assignedTo.length} team member${assignedTo.length === 1 ? '' : 's'}.`,
      'success'
    )
  } catch (error) {
    console.error('Unable to save assigned task:', error)
    setTodoFormStatus(error.message || 'The assigned task could not be saved.', 'error')
  } finally {
    setTodoSaving(false)
  }
}

async function reloadTodos() {
  const { data, error } = await supabase
    .from('home_todo_items')
    .select('id, title, assigned_to, sort_order, is_active, created_at, updated_at')
    .order('sort_order')
    .order('created_at')

  if (error) throw error
  state.todos = Array.isArray(data) ? data : []
  renderTodos()
}

function handleTodoListAction(event) {
  const button = event.target.closest('button[data-todo-action]')
  if (!button || state.todoSaving) return

  const item = state.todos.find(todo => todo.id === button.dataset.id)
  if (!item) return

  if (button.dataset.todoAction === 'edit') {
    beginTodoEditing(item)
    return
  }

  if (button.dataset.todoAction === 'toggle') {
    updateTodoActiveState(item)
    return
  }

}

function beginTodoEditing(item) {
  state.todoEditingId = item.id
  setTodoAssigneeSelection(item.assigned_to ? [item.assigned_to] : [])
  elements.todoTitle.value = item.title
  elements.todoSortOrder.value = String(item.sort_order || 0)
  elements.todoIsActive.checked = item.is_active === true
  elements.todoEditorTitle.textContent = 'Edit assigned task'
  elements.todoEditorHint.textContent = item.assigned_to
    ? 'Update this assignment or select additional members to receive a copy.'
    : 'Select one or more members to replace this existing team-wide task.'
  elements.todoSave.textContent = 'Save changes'
  elements.todoCancelEdit.hidden = false
  setTodoFormStatus('')
  elements.todoTitle.focus()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function resetTodoEditor() {
  state.todoEditingId = null
  elements.todoForm.reset()
  clearTodoAssignees()
  elements.todoSortOrder.value = '0'
  elements.todoIsActive.checked = true
  elements.todoEditorTitle.textContent = 'Assign a task'
  elements.todoEditorHint.textContent = 'Add an item to selected team members\' daily checklists.'
  elements.todoSave.textContent = 'Assign task'
  elements.todoCancelEdit.hidden = true
}

async function updateTodoActiveState(item) {
  setTodoSaving(true)
  setTodoFormStatus(item.is_active ? 'Deactivating task...' : 'Activating task...')

  try {
    const { error } = await supabase
      .from('home_todo_items')
      .update({
        is_active: !item.is_active,
        updated_at: new Date().toISOString()
      })
      .eq('id', item.id)

    if (error) throw error
    await reloadTodos()
    setTodoFormStatus(item.is_active ? 'Task removed from the daily checklist.' : 'Task activated.', 'success')
  } catch (error) {
    console.error('Unable to change task visibility:', error)
    setTodoFormStatus(error.message || 'The task visibility could not be changed.', 'error')
  } finally {
    setTodoSaving(false)
  }
}

function renderTodos() {
  elements.todoList.replaceChildren()
  const selectedUser = elements.todoUserFilter.value
  const visibleTodos = state.todos.filter(item => !selectedUser || item.assigned_to === selectedUser)
  elements.todoCount.textContent = String(visibleTodos.length)

  if (!visibleTodos.length) {
    renderTodoListState('No assigned tasks match this filter.')
    return
  }

  for (const item of visibleTodos) {
    elements.todoList.appendChild(createTodoItem(item))
  }
}

function createTodoItem(item) {
  const article = document.createElement('article')
  article.className = 'todo-management-item'

  const heading = document.createElement('div')
  heading.className = 'todo-item-heading'

  const title = document.createElement('h3')
  title.textContent = item.title

  const status = document.createElement('span')
  status.className = `status-badge ${item.is_active ? 'published' : 'draft'}`
  status.textContent = item.is_active ? 'Active' : 'Inactive'
  heading.append(title, status)

  const meta = document.createElement('p')
  const profile = state.profiles.find(row => row.user_id === item.assigned_to)
  meta.textContent = `${profile ? profileLabel(profile) : 'Everyone (existing task)'} · Order ${item.sort_order || 0}`

  const actions = document.createElement('div')
  actions.className = 'announcement-actions'
  actions.append(
    createTodoActionButton('Edit', 'edit', item.id),
    createTodoActionButton(item.is_active ? 'Deactivate' : 'Activate', 'toggle', item.id)
  )

  article.append(heading, meta, actions)
  return article
}

function createTodoActionButton(label, action, id, className = '') {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.dataset.todoAction = action
  button.dataset.id = id
  button.className = className
  return button
}

function renderTodoListState(message, isError = false) {
  elements.todoList.replaceChildren()
  const paragraph = document.createElement('p')
  paragraph.className = `list-state${isError ? ' error' : ''}`
  paragraph.textContent = message
  elements.todoList.appendChild(paragraph)
}

function setTodoSaving(saving) {
  state.todoSaving = saving
  elements.todoSave.disabled = saving
}

function setTodoFormStatus(message, type = '') {
  elements.todoFormStatus.textContent = message
  elements.todoFormStatus.className = `form-status${type ? ` ${type}` : ''}`
}

function profileLabel(profile) {
  const name = profile.full_name || profile.email || 'Unnamed user'
  return profile.employee_id ? `${name} · ${profile.employee_id}` : name
}

async function handleSubmit(event) {
  event.preventDefault()
  if (state.saving || !state.access) return

  const action = event.submitter?.value === 'draft' ? 'draft' : 'published'
  const title = elements.title.value.trim()
  const body = sanitizeAnnouncementHtml(elements.messageEditor.innerHTML)
  const bodyText = announcementPlainText(body)
  const category = elements.category.value.trim() || 'General'

  if (!title || !bodyText) {
    setFormStatus('Enter a title and message before saving.', 'error')
    return
  }

  if (bodyText.length > 2000) {
    setFormStatus('The announcement message must be 2,000 characters or fewer.', 'error')
    return
  }

  elements.body.value = body

  const publisherName = state.access.full_name || state.access.email || 'Administrator'
  const now = new Date().toISOString()
  const payload = {
    title,
    body,
    category,
    status: action,
    published_by: action === 'published' ? state.access.user_id : null,
    published_by_name: action === 'published' ? publisherName : null,
    published_at: action === 'published' ? now : null,
    updated_at: now
  }

  setSaving(true)
  setFormStatus(action === 'published' ? 'Publishing announcement...' : 'Saving draft...')

  try {
    let query

    if (state.editingId) {
      query = supabase
        .from('team_announcements')
        .update(payload)
        .eq('id', state.editingId)
    } else {
      query = supabase
        .from('team_announcements')
        .insert({
          ...payload,
          created_by: state.access.user_id,
          created_by_name: publisherName
        })
    }

    const { error } = await query
    if (error) throw error

    resetEditor()
    await loadAnnouncements()
    setFormStatus(action === 'published' ? 'Announcement published to Home.' : 'Draft saved.', 'success')
  } catch (error) {
    console.error('Unable to save announcement:', error)
    setFormStatus(error.message || 'The announcement could not be saved.', 'error')
  } finally {
    setSaving(false)
  }
}

async function handleListAction(event) {
  const button = event.target.closest('button[data-action]')
  if (!button || state.saving) return

  const item = state.announcements.find(row => row.id === button.dataset.id)
  if (!item) return

  if (button.dataset.action === 'edit') {
    beginEditing(item)
    return
  }

  if (button.dataset.action === 'delete') {
    if (!window.confirm(`Delete “${item.title}”? This cannot be undone.`)) return
    await deleteAnnouncement(item)
    return
  }

  if (button.dataset.action === 'publish') {
    await setPublicationStatus(item, 'published')
    return
  }

  if (button.dataset.action === 'draft') {
    await setPublicationStatus(item, 'draft')
  }
}

function beginEditing(item) {
  state.editingId = item.id
  elements.title.value = item.title
  elements.category.value = item.category
  renderAnnouncementHtml(elements.messageEditor, item.body)
  elements.body.value = sanitizeAnnouncementHtml(item.body)
  elements.editorTitle.textContent = 'Edit announcement'
  elements.editorHint.textContent = item.status === 'published'
    ? 'Save as a draft to remove it from Home, or publish your changes.'
    : 'Update this draft and publish it when it is ready.'
  elements.cancelEdit.hidden = false
  updateCharacterCount()
  setFormStatus('')
  elements.title.focus()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function resetEditor() {
  state.editingId = null
  elements.form.reset()
  elements.messageEditor.replaceChildren()
  elements.body.value = ''
  elements.editorTitle.textContent = 'Create announcement'
  elements.editorHint.textContent = 'Add a team update and publish it when it is ready.'
  elements.cancelEdit.hidden = true
  updateCharacterCount()
}

async function setPublicationStatus(item, status) {
  const isPublishing = status === 'published'
  const publisherName = state.access.full_name || state.access.email || 'Administrator'
  const now = new Date().toISOString()

  setSaving(true)
  setFormStatus(isPublishing ? 'Publishing announcement...' : 'Moving announcement to drafts...')

  try {
    const { error } = await supabase
      .from('team_announcements')
      .update({
        status,
        published_by: isPublishing ? state.access.user_id : null,
        published_by_name: isPublishing ? publisherName : null,
        published_at: isPublishing ? now : null,
        updated_at: now
      })
      .eq('id', item.id)

    if (error) throw error
    await loadAnnouncements()
    setFormStatus(isPublishing ? 'Announcement published to Home.' : 'Announcement moved to drafts.', 'success')
  } catch (error) {
    console.error('Unable to update announcement status:', error)
    setFormStatus(error.message || 'The announcement status could not be changed.', 'error')
  } finally {
    setSaving(false)
  }
}

async function deleteAnnouncement(item) {
  setSaving(true)
  setFormStatus('Deleting announcement...')

  try {
    const { error } = await supabase
      .from('team_announcements')
      .delete()
      .eq('id', item.id)

    if (error) throw error
    if (state.editingId === item.id) resetEditor()
    await loadAnnouncements()
    setFormStatus('Announcement deleted.', 'success')
  } catch (error) {
    console.error('Unable to delete announcement:', error)
    setFormStatus(error.message || 'The announcement could not be deleted.', 'error')
  } finally {
    setSaving(false)
  }
}

function renderAnnouncements() {
  elements.list.replaceChildren()
  elements.count.textContent = String(state.announcements.length)

  if (!state.announcements.length) {
    renderListState('No announcements have been created yet.')
    return
  }

  for (const item of state.announcements) {
    elements.list.appendChild(createAnnouncementItem(item))
  }
}

function createAnnouncementItem(item) {
  const article = document.createElement('article')
  article.className = 'announcement-item'

  const heading = document.createElement('div')
  heading.className = 'announcement-item-head'

  const title = document.createElement('h3')
  title.textContent = item.title

  const status = document.createElement('span')
  status.className = `status-badge ${item.status}`
  status.textContent = item.status === 'published' ? 'Published' : 'Draft'
  heading.append(title, status)

  const body = document.createElement('div')
  body.className = 'announcement-rich-preview'
  renderAnnouncementHtml(body, item.body)

  const meta = document.createElement('div')
  meta.className = 'announcement-meta'

  const category = document.createElement('span')
  category.className = 'category-badge'
  category.textContent = item.category

  const detail = document.createElement('span')
  detail.textContent = item.status === 'published'
    ? `Published by ${item.published_by_name || 'Administrator'} on ${formatDateTime(item.published_at)}`
    : `Created by ${item.created_by_name || 'Administrator'} on ${formatDateTime(item.created_at)}`
  meta.append(category, detail)

  const actions = document.createElement('div')
  actions.className = 'announcement-actions'
  actions.append(
    createActionButton('Edit', 'edit', item.id),
    createActionButton(item.status === 'published' ? 'Move to draft' : 'Publish', item.status === 'published' ? 'draft' : 'publish', item.id),
    createActionButton('Delete', 'delete', item.id, 'danger')
  )

  article.append(heading, body, meta, actions)
  return article
}

function createActionButton(label, action, id, className = '') {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.dataset.action = action
  button.dataset.id = id
  button.className = className
  return button
}

function renderListState(message, isError = false) {
  elements.list.replaceChildren()
  const paragraph = document.createElement('p')
  paragraph.className = `list-state${isError ? ' error' : ''}`
  paragraph.textContent = message
  elements.list.appendChild(paragraph)
}

function updateCharacterCount() {
  const sanitized = sanitizeAnnouncementHtml(elements.messageEditor.innerHTML)
  const characterCount = announcementPlainText(sanitized).length
  elements.body.value = sanitized
  elements.characterCount.textContent = `${characterCount} / 2000`
  elements.characterCount.classList.toggle('over-limit', characterCount > 2000)
}

function applyMessageFormat(event) {
  const command = event.currentTarget.dataset.formatCommand
  if (!['bold', 'italic', 'underline', 'insertUnorderedList'].includes(command)) return

  elements.messageEditor.focus()
  document.execCommand(command, false, null)
  updateCharacterCount()
}

function handleMessagePaste(event) {
  event.preventDefault()
  const text = event.clipboardData?.getData('text/plain') || ''
  const inserted = document.execCommand('insertText', false, text)

  if (!inserted) {
    insertTextAtSelection(text)
  }

  updateCharacterCount()
}

function insertTextAtSelection(text) {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return

  const range = selection.getRangeAt(0)
  range.deleteContents()
  const textNode = document.createTextNode(text)
  range.insertNode(textNode)
  range.setStartAfter(textNode)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

function setSaving(saving) {
  state.saving = saving
  elements.saveDraft.disabled = saving
  elements.publish.disabled = saving
}

function setFormStatus(message, type = '') {
  elements.formStatus.textContent = message
  elements.formStatus.className = `form-status${type ? ` ${type}` : ''}`
}

function formatDateTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'an unknown date'

  return new Intl.DateTimeFormat('en-PH', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
}
