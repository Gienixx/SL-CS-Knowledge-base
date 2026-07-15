import assert from 'node:assert/strict'
import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const pathFromRoot = path => resolve(root, path)
const normalizePath = path => relative(root, path).split(sep).join('/')

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

function cleanReference(value) {
  return String(value || '').split('#')[0].split('?')[0].trim()
}

function localModuleReferences(source) {
  const references = new Set()
  const patterns = [
    /\bimport\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'";]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(source))) {
      const reference = cleanReference(match[1])
      if (reference.startsWith('.') || reference.startsWith('/')) {
        references.add(reference)
      }
    }
  }

  return [...references]
}

async function resolveModule(importer, reference) {
  const base = reference.startsWith('/')
    ? pathFromRoot(reference.slice(1))
    : resolve(dirname(pathFromRoot(importer)), reference)
  const candidates = extname(base) ? [base] : [base, `${base}.js`, resolve(base, 'index.js')]

  for (const candidate of candidates) {
    try {
      await access(candidate)
      return normalizePath(candidate)
    } catch {
      // Try the next supported module path.
    }
  }

  throw new Error(`${importer} imports missing module ${reference}`)
}

async function collectModuleGraph(entryFiles) {
  const visited = new Set()
  const queue = [...entryFiles]

  while (queue.length) {
    const current = queue.shift()
    if (visited.has(current)) continue
    visited.add(current)

    const source = await readFile(pathFromRoot(current), 'utf8')
    for (const reference of localModuleReferences(source)) {
      const resolved = await resolveModule(current, reference)
      if (!visited.has(resolved)) queue.push(resolved)
    }
  }

  return visited
}

async function htmlFiles() {
  const rootEntries = await readdir(root, { withFileTypes: true })
  const files = rootEntries
    .filter(entry => entry.isFile() && entry.name.endsWith('.html'))
    .map(entry => entry.name)
  files.push(...(await filesBelow('partials')).filter(path => path.endsWith('.html')))
  return files
}

async function browserEntryModules() {
  const entries = new Set()
  const pattern = /\bsrc=["']([^"']+\.js(?:[?#][^"']*)?)["']/g

  for (const htmlPath of await htmlFiles()) {
    const source = await readFile(pathFromRoot(htmlPath), 'utf8')
    let match
    while ((match = pattern.exec(source))) {
      const reference = cleanReference(match[1])
      if (!reference || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)) continue
      entries.add(await resolveModule(htmlPath, reference))
    }
  }

  return [...entries]
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
    'scripts/data-details-utils.js',
    'scripts/user-management.js', 'styles/user-management.css',
    'functions/list-users.js', 'functions/user-settings.js',
    'functions/remove-account.js', 'functions/delete-user.js',
    'functions/api/sync-dashboard-v3.js', 'functions/api/sync-zendesk.js',
    'functions/api/sync-zendesk-events.js', 'functions/api/sync-zendesk-sla.js',
    'functions/api/zendesk-test.js', 'workers/zendesk-health/index.js'
  ]
  for (const path of removed) assert.equal(await exists(path), false, `${path} should be removed`)
})

test('current site and operational entry points remain available', async () => {
  const required = [
    'index.html', 'login.html', 'home.html', 'KB.html', 'article.html',
    'user-management.html', 'workforce.html', 'dashboard.html', 'report-details.html',
    'agent-analytics.html', 'response-times.html', 'reporting-operations.html',
    'functions/api/sync-dashboard.js', 'apps-script/dashboard-sync.gs',
    'supabase/migrations-legacy/2026070402_reporting_operations.sql',
    'supabase/verification/reporting_acceptance_check.sql'
  ]
  for (const path of required) assert.equal(await exists(path), true, `${path} should exist`)
})

test('local href and src references in HTML resolve to repository files', async () => {
  const missing = []
  const referencePattern = /\b(?:href|src)=["']([^"']+)["']/g

  for (const htmlPath of await htmlFiles()) {
    const content = await readFile(pathFromRoot(htmlPath), 'utf8')
    let match
    while ((match = referencePattern.exec(content))) {
      const raw = match[1].trim()
      if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue
      const clean = cleanReference(raw)
      if (!clean || clean.includes('${')) continue

      const baseDirectory = htmlPath.startsWith('partials/')
        ? root
        : dirname(pathFromRoot(htmlPath))
      const target = clean.startsWith('/')
        ? pathFromRoot(clean.slice(1))
        : resolve(baseDirectory, clean)

      try { await access(target) } catch { missing.push(`${htmlPath} -> ${raw}`) }
    }
  }

  assert.deepEqual(missing, [])
})

test('every browser script is reachable from a live HTML page', async () => {
  const graph = await collectModuleGraph(await browserEntryModules())
  const scripts = (await filesBelow('scripts')).filter(path => path.endsWith('.js'))
  assert.deepEqual(scripts.filter(path => !graph.has(path)).sort(), [])
})

test('every shared function and configuration module is reachable from a live endpoint', async () => {
  const functionFiles = (await filesBelow('functions')).filter(path => path.endsWith('.js'))
  const endpointRoots = functionFiles.filter(path => !path.startsWith('functions/_shared/'))
  const graph = await collectModuleGraph(endpointRoots)
  const shared = functionFiles.filter(path => path.startsWith('functions/_shared/'))
  const config = (await filesBelow('config')).filter(path => path.endsWith('.js'))
  const disconnected = [...shared, ...config].filter(path => !graph.has(path)).sort()
  assert.deepEqual(disconnected, [])
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
