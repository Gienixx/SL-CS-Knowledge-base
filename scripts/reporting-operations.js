import {
  formatCount,
  formatDate,
  logout,
  requireApprovedUser,
  supabase
} from './sheet-reporting.js?v=1'
import {
  CSV_DATASETS,
  exportCsvDataset
} from './csv-export.js?v=1'

function elements() {
  return {
    page: document.getElementById('operationsPage'),
    status: document.getElementById('operationsStatus'),
    content: document.getElementById('operationsContent'),
    logout: document.getElementById('operationsLogoutLink'),
    summary: document.getElementById('operationsSummary'),
    alertMeta: document.getElementById('operationsAlertMeta'),
    alerts: document.getElementById('operationsAlerts'),
    qualityMeta: document.getElementById('operationsQualityMeta'),
    qualityBody: document.getElementById('operationsQualityBody'),
    syncMeta: document.getElementById('operationsSyncMeta'),
    syncBody: document.getElementById('operationsSyncBody'),
    auditMeta: document.getElementById('operationsAuditMeta'),
    auditBody: document.getElementById('operationsAuditBody'),
    exportForm: document.getElementById('operationsExportForm'),
    exportDataset: document.getElementById('operationsExportDataset'),
    exportStart: document.getElementById('operationsExportStart'),
    exportEnd: document.getElementById('operationsExportEnd'),
    exportButton: document.getElementById('operationsExportButton'),
    exportStatus: document.getElementById('operationsExportStatus')
  }
}

function formatTimestamp(value) {
  if (!value) return 'Unavailable'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date)
}

function formatAge(value) {
  if (!value) return 'Unavailable'
  const milliseconds = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(milliseconds)) return 'Unavailable'
  const hours = Math.max(0, milliseconds / 3600000)
  if (hours < 1) return `${Math.round(hours * 60)} min ago`
  if (hours < 48) return `${formatCount(hours)} hr ago`
  return `${formatCount(hours / 24)} days ago`
}

function badge(status) {
  const span = document.createElement('span')
  span.className = 'operations-status-badge'
  span.dataset.status = String(status || 'unknown').toLowerCase()
  span.textContent = status || 'unknown'
  return span
}

function addSummaryCard(container, label, value, caption) {
  const card = document.createElement('article')
  card.className = 'operations-summary-card'
  const heading = document.createElement('h2')
  heading.textContent = label
  const strong = document.createElement('strong')
  strong.textContent = value
  const paragraph = document.createElement('p')
  paragraph.textContent = caption
  card.append(heading, strong, paragraph)
  container.appendChild(card)
}

function renderSummary(ui, latestRun, alerts, qualityRows) {
  ui.summary.replaceChildren()
  addSummaryCard(
    ui.summary,
    'Latest sync',
    latestRun?.status || 'Unavailable',
    formatTimestamp(latestRun?.completed_at || latestRun?.started_at)
  )
  addSummaryCard(
    ui.summary,
    'Quality status',
    latestRun?.quality_status || 'Unavailable',
    `${qualityRows.length} latest checks`
  )
  addSummaryCard(
    ui.summary,
    'Report date',
    latestRun?.report_date ? formatDate(latestRun.report_date) : 'Unavailable',
    'Latest synchronized date'
  )
  addSummaryCard(
    ui.summary,
    'Rows imported',
    formatCount(latestRun?.rows_imported),
    'Latest synchronization'
  )
  addSummaryCard(
    ui.summary,
    'Active alerts',
    formatCount(alerts.length),
    latestRun ? formatAge(latestRun.completed_at || latestRun.started_at) : 'No synchronization history'
  )
}

function renderAlerts(ui, alerts) {
  ui.alerts.replaceChildren()
  ui.alertMeta.textContent = `${formatCount(alerts.length)} active alert${alerts.length === 1 ? '' : 's'}`
  if (!alerts.length) {
    const empty = document.createElement('div')
    empty.className = 'operations-empty'
    empty.textContent = 'No active reporting alerts.'
    ui.alerts.appendChild(empty)
    return
  }

  alerts.forEach(alert => {
    const article = document.createElement('article')
    article.className = 'operations-alert'
    article.dataset.severity = alert.severity
    const alertBadge = document.createElement('span')
    alertBadge.className = 'operations-alert-badge'
    alertBadge.textContent = alert.severity
    const copy = document.createElement('div')
    copy.className = 'operations-alert-copy'
    const title = document.createElement('h3')
    title.textContent = alert.title
    const message = document.createElement('p')
    message.textContent = alert.message
    copy.append(title, message)
    const time = document.createElement('time')
    time.dateTime = alert.created_at || ''
    time.textContent = formatTimestamp(alert.created_at)
    article.append(alertBadge, copy, time)
    ui.alerts.appendChild(article)
  })
}

function appendMessageRow(body, columnCount, text) {
  const row = document.createElement('tr')
  const cell = document.createElement('td')
  cell.colSpan = columnCount
  cell.className = 'operations-table-message'
  cell.textContent = text
  row.appendChild(cell)
  body.appendChild(row)
}

function renderQuality(ui, rows) {
  ui.qualityBody.replaceChildren()
  ui.qualityMeta.textContent = `${formatCount(rows.length)} check${rows.length === 1 ? '' : 's'}`
  if (!rows.length) {
    appendMessageRow(ui.qualityBody, 4, 'No data-quality checks are available for the latest run.')
    return
  }
  rows.forEach(item => {
    const row = document.createElement('tr')
    const check = document.createElement('td')
    check.textContent = item.check_key
    const status = document.createElement('td')
    status.appendChild(badge(item.status))
    const details = document.createElement('td')
    details.textContent = item.details || 'No details supplied.'
    const checked = document.createElement('td')
    checked.textContent = formatTimestamp(item.checked_at)
    row.append(check, status, details, checked)
    ui.qualityBody.appendChild(row)
  })
}

function renderSyncHistory(ui, rows) {
  ui.syncBody.replaceChildren()
  ui.syncMeta.textContent = `${formatCount(rows.length)} run${rows.length === 1 ? '' : 's'}`
  if (!rows.length) {
    appendMessageRow(ui.syncBody, 6, 'No synchronization history is available.')
    return
  }
  rows.forEach(item => {
    const row = document.createElement('tr')
    const started = document.createElement('td')
    started.textContent = formatTimestamp(item.started_at)
    const status = document.createElement('td')
    status.appendChild(badge(item.status))
    const quality = document.createElement('td')
    quality.appendChild(badge(item.quality_status))
    const reportDate = document.createElement('td')
    reportDate.textContent = item.report_date ? formatDate(item.report_date) : 'Unavailable'
    const imported = document.createElement('td')
    imported.textContent = formatCount(item.rows_imported)
    const error = document.createElement('td')
    error.textContent = item.error_message || '—'
    row.append(started, status, quality, reportDate, imported, error)
    ui.syncBody.appendChild(row)
  })
}

function renderAudit(ui, rows) {
  ui.auditBody.replaceChildren()
  ui.auditMeta.textContent = `${formatCount(rows.length)} event${rows.length === 1 ? '' : 's'}`
  if (!rows.length) {
    appendMessageRow(ui.auditBody, 5, 'No reporting audit events are available.')
    return
  }
  rows.forEach(item => {
    const row = document.createElement('tr')
    const time = document.createElement('td')
    time.textContent = formatTimestamp(item.created_at)
    const severity = document.createElement('td')
    severity.appendChild(badge(item.severity === 'error' ? 'fail' : item.severity))
    const title = document.createElement('td')
    title.textContent = item.title
    const details = document.createElement('td')
    details.textContent = item.details || '—'
    const actor = document.createElement('td')
    actor.textContent = item.actor_email || 'System'
    row.append(time, severity, title, details, actor)
    ui.auditBody.appendChild(row)
  })
}

async function loadOperationsData() {
  const [syncResult, alertResult, auditResult] = await Promise.all([
    supabase
      .from('dashboard_sync_runs')
      .select('id, started_at, completed_at, status, report_date, rows_imported, error_message, sync_source, reporting_source, quality_status')
      .order('started_at', { ascending: false })
      .limit(25),
    supabase
      .from('dashboard_active_alerts')
      .select('alert_key, alert_type, severity, title, message, sync_run_id, metadata, created_at')
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('dashboard_audit_events')
      .select('id, event_type, severity, title, details, sync_run_id, actor_email, metadata, created_at')
      .order('created_at', { ascending: false })
      .limit(100)
  ])

  if (syncResult.error) throw syncResult.error
  if (alertResult.error) throw alertResult.error
  if (auditResult.error) throw auditResult.error

  const syncRuns = Array.isArray(syncResult.data) ? syncResult.data : []
  const latestRun = syncRuns[0] || null
  let qualityRows = []

  if (latestRun) {
    const qualityResult = await supabase
      .from('dashboard_data_quality_results')
      .select('check_key, status, observed_value, details, checked_at')
      .eq('sync_run_id', String(latestRun.id))
      .order('check_key', { ascending: true })
    if (qualityResult.error) throw qualityResult.error
    qualityRows = Array.isArray(qualityResult.data) ? qualityResult.data : []
  }

  return {
    syncRuns,
    latestRun,
    alerts: Array.isArray(alertResult.data) ? alertResult.data : [],
    auditRows: Array.isArray(auditResult.data) ? auditResult.data : [],
    qualityRows
  }
}

function initializeExport(ui, reloadAudit) {
  ui.exportForm.addEventListener('submit', async event => {
    event.preventDefault()
    const dataset = ui.exportDataset.value
    const start = ui.exportStart.value
    const end = ui.exportEnd.value

    if (!CSV_DATASETS[dataset]) {
      ui.exportStatus.textContent = 'Choose a supported dataset.'
      return
    }
    if (start && end && start > end) {
      ui.exportStatus.textContent = 'The start date cannot be after the end date.'
      return
    }

    ui.exportButton.disabled = true
    ui.exportStatus.textContent = `Preparing ${CSV_DATASETS[dataset].label}...`

    try {
      const result = await exportCsvDataset(supabase, dataset, start, end)
      const { error } = await supabase.rpc('record_dashboard_export', {
        p_dataset: dataset,
        p_row_count: result.rowCount,
        p_start_date: start || null,
        p_end_date: end || null
      })
      if (error) throw error
      ui.exportStatus.textContent = `${result.filename} created with ${formatCount(result.rowCount)} rows.`
      await reloadAudit()
    } catch (error) {
      console.error('Unable to export reporting data:', error)
      ui.exportStatus.textContent = error?.message || 'The CSV export could not be created.'
    } finally {
      ui.exportButton.disabled = false
    }
  })
}

function showError(ui, error) {
  ui.page.setAttribute('aria-busy', 'false')
  ui.content.hidden = true
  ui.status.hidden = false
  ui.status.replaceChildren()
  const heading = document.createElement('h2')
  heading.textContent = 'Reporting Operations unavailable'
  const paragraph = document.createElement('p')
  paragraph.textContent = error?.message || 'The operations data could not be loaded.'
  ui.status.append(heading, paragraph)
}

async function initialize() {
  const ui = elements()
  ui.logout.addEventListener('click', event => {
    event.preventDefault()
    logout()
  })

  try {
    const user = await requireApprovedUser()
    if (!user) return

    const renderAll = async () => {
      const data = await loadOperationsData()
      renderSummary(ui, data.latestRun, data.alerts, data.qualityRows)
      renderAlerts(ui, data.alerts)
      renderQuality(ui, data.qualityRows)
      renderSyncHistory(ui, data.syncRuns)
      renderAudit(ui, data.auditRows)
      return data
    }

    await renderAll()
    initializeExport(ui, async () => {
      const { data, error } = await supabase
        .from('dashboard_audit_events')
        .select('id, event_type, severity, title, details, sync_run_id, actor_email, metadata, created_at')
        .order('created_at', { ascending: false })
        .limit(100)
      if (error) throw error
      renderAudit(ui, Array.isArray(data) ? data : [])
    })

    ui.status.hidden = true
    ui.content.hidden = false
    ui.page.setAttribute('aria-busy', 'false')
  } catch (error) {
    console.error('Unable to initialize reporting operations:', error)
    showError(ui, error)
  }
}

initialize()
