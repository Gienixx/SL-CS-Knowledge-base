import assert from 'node:assert/strict'
import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const pathFromRoot = path => resolve(root, path)

async function exists(path) {
  try {
    await access(pathFromRoot(path))
    return true
  } catch {
    return false
  }
}

async function filesBelow(relativeDirectory) {
  const directory = pathFromRoot(relativeDirectory)
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`
    if (entry.isDirectory()) files.push(...await filesBelow(relativePath))
    else files.push(relativePath)
  }

  return files
}

test('Supabase filenames use capability names instead of phase or step labels', async () => {
  const files = [
    ...await filesBelow('supabase/migrations'),
    ...await filesBelow('supabase/verification')
  ]
  assert.deepEqual(files.filter(path => /(?:phase|step)[-_]?\d/i.test(path)), [])
})

test('retired disconnected entry points and integrations are absent', async () => {
  const removed = [
    'admin.html', 'invite-user.html', 'data-details.html',
    'scripts/admin.js', 'scripts/invite-user.js', 'scripts/data-details.js',
    'functions/api/sync-dashboard-v3.js', 'functions/api/sync-zendesk.js',
    'functions/api/sync-zendesk-events.js', 'functions/api/sync-zendesk-sla.js',
    'functions/api/zendesk-test.js', 'workers/zendesk-health/index.js'
  ]
  for (const path of removed) assert.equal(await exists(path), false, `${path} should be removed`)
})

test('current site and operational entry points remain available', async () => {
  const required = [
    'index.html', 'login.html', 'home.html', 'KB.html', 'article.html',
    'user-management.html', 'dashboard.html', 'report-details.html',
    'agent-analytics.html', 'response-times.html', 'reporting-operations.html',
    'functions/api/sync-dashboard.js', 'apps-script/dashboard-sync.gs',
    'supabase/migrations/2026070402_reporting_operations.sql',
    'supabase/verification/reporting_acceptance_check.sql'
  ]
  for (const path of required) assert.equal(await exists(path), true, `${path} should exist`)
})

test('local href and src references in HTML resolve to repository files', async () => {
  const rootEntries = await readdir(root, { withFileTypes: true })
  const htmlFiles = rootEntries.filter(entry => entry.isFile() && entry.name.endsWith('.html')).map(entry => entry.name)
  htmlFiles.push(...(await filesBelow('partials')).filter(path => path.endsWith('.html')))
  const missing = []
  const referencePattern = /\b(?:href|src)=["']([^"']+)["']/g

  for (const htmlPath of htmlFiles) {
    const content = await readFile(pathFromRoot(htmlPath), 'utf8')
    let match
    while ((match = referencePattern.exec(content))) {
      const raw = match[1].trim()
      if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue
      const clean = raw.split('#')[0].split('?')[0]
      if (!clean || clean.includes('${')) continue
      const target = clean.startsWith('/') ? pathFromRoot(clean.slice(1)) : resolve(dirname(pathFromRoot(htmlPath)), clean)
      try { await access(target) } catch { missing.push(`${htmlPath} -> ${raw}`) }
    }
  }

  assert.deepEqual(missing, [])
})

test('index.html is the canonical landing page', async () => {
  const [index, compatibility] = await Promise.all([
    readFile(pathFromRoot('index.html'), 'utf8'),
    readFile(pathFromRoot('index-modular.html'), 'utf8')
  ])
  assert.match(index, /data-include="partials\/hero\.html"/)
  assert.doesNotMatch(index, /http-equiv="refresh"/i)
  assert.match(compatibility, /url=\.\/index\.html/)
})
