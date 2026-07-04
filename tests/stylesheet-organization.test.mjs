import assert from 'node:assert/strict'
import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const pathFromRoot = path => resolve(root, path)
const normalizePath = path => relative(root, path).split(sep).join('/')

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

function isExternalReference(value) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:|var\()/i.test(value)
}

async function resolveLocalReference(importer, reference) {
  const clean = cleanReference(reference)
  if (!clean || isExternalReference(clean)) return null

  const target = clean.startsWith('/')
    ? pathFromRoot(clean.slice(1))
    : resolve(dirname(pathFromRoot(importer)), clean)

  await access(target)
  return normalizePath(target)
}

async function resolveBrowserReference(reference) {
  const clean = cleanReference(reference)
  if (!clean || isExternalReference(clean)) return null

  const target = clean.startsWith('/')
    ? pathFromRoot(clean.slice(1))
    : pathFromRoot(clean.replace(/^\.\//, ''))

  await access(target)
  return normalizePath(target)
}

async function rootHtmlFiles() {
  const entries = await readdir(root, { withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.html'))
    .map(entry => entry.name)
}

test('all repository stylesheets are stored under styles/', async () => {
  const rootEntries = await readdir(root, { withFileTypes: true })
  const rootStylesheets = rootEntries
    .filter(entry => entry.isFile() && entry.name.endsWith('.css'))
    .map(entry => entry.name)

  const organizedStylesheets = (await filesBelow('styles'))
    .filter(path => path.endsWith('.css'))

  assert.deepEqual(rootStylesheets, [])
  assert.ok(organizedStylesheets.length > 0, 'styles/ should contain the site stylesheets')
})

test('HTML and JavaScript stylesheet references resolve inside styles/', async () => {
  const resolved = []
  const htmlPattern = /<link\b[^>]*\brel=["'][^"']*stylesheet[^"']*["'][^>]*\bhref=["']([^"']+\.css(?:[?#][^"']*)?)["'][^>]*>|<link\b[^>]*\bhref=["']([^"']+\.css(?:[?#][^"']*)?)["'][^>]*\brel=["'][^"']*stylesheet[^"']*["'][^>]*>/gi

  for (const htmlPath of await rootHtmlFiles()) {
    const source = await readFile(pathFromRoot(htmlPath), 'utf8')
    let match
    while ((match = htmlPattern.exec(source))) {
      const target = await resolveLocalReference(htmlPath, match[1] || match[2])
      if (target) resolved.push(target)
    }
  }

  const scriptFiles = (await filesBelow('scripts')).filter(path => path.endsWith('.js'))
  const scriptPattern = /["'`]([^"'`]+\.css(?:[?#][^"'`]*)?)["'`]/g

  for (const scriptPath of scriptFiles) {
    const source = await readFile(pathFromRoot(scriptPath), 'utf8')
    let match
    while ((match = scriptPattern.exec(source))) {
      const target = await resolveBrowserReference(match[1])
      if (target) resolved.push(target)
    }
  }

  assert.ok(resolved.length > 0, 'At least one stylesheet should be linked')
  assert.deepEqual(
    resolved.filter(path => !path.startsWith('styles/')),
    [],
    'Local stylesheet references must point into styles/'
  )
})

test('every stylesheet is connected to a live page, script, or imported stylesheet', async () => {
  const stylesheets = (await filesBelow('styles'))
    .filter(path => path.endsWith('.css'))
    .sort()
  const referenced = new Set()

  const htmlPattern = /\bhref=["']([^"']+\.css(?:[?#][^"']*)?)["']/g
  for (const htmlPath of await rootHtmlFiles()) {
    const source = await readFile(pathFromRoot(htmlPath), 'utf8')
    let match
    while ((match = htmlPattern.exec(source))) {
      const target = await resolveLocalReference(htmlPath, match[1])
      if (target) referenced.add(target)
    }
  }

  const scriptFiles = (await filesBelow('scripts')).filter(path => path.endsWith('.js'))
  const scriptPattern = /["'`]([^"'`]+\.css(?:[?#][^"'`]*)?)["'`]/g
  for (const scriptPath of scriptFiles) {
    const source = await readFile(pathFromRoot(scriptPath), 'utf8')
    let match
    while ((match = scriptPattern.exec(source))) {
      const target = await resolveBrowserReference(match[1])
      if (target) referenced.add(target)
    }
  }

  for (const stylesheet of stylesheets) {
    const source = await readFile(pathFromRoot(stylesheet), 'utf8')
    const importPattern = /@import\s+(?:url\(\s*)?["']([^"']+\.css(?:[?#][^"']*)?)["']/g
    let match
    while ((match = importPattern.exec(source))) {
      const target = await resolveLocalReference(stylesheet, match[1])
      if (target) referenced.add(target)
    }
  }

  assert.deepEqual(
    stylesheets.filter(path => !referenced.has(path)),
    [],
    'Every stylesheet should be connected to the active site'
  )
})

test('relative assets referenced by stylesheets still resolve after the move', async () => {
  const stylesheets = (await filesBelow('styles')).filter(path => path.endsWith('.css'))
  const missing = []
  const urlPattern = /url\(\s*(["']?)([^"')]+)\1\s*\)/g

  for (const stylesheet of stylesheets) {
    const source = await readFile(pathFromRoot(stylesheet), 'utf8')
    let match

    while ((match = urlPattern.exec(source))) {
      const reference = match[2].trim()
      if (!reference || isExternalReference(reference)) continue

      try {
        await resolveLocalReference(stylesheet, reference)
      } catch {
        missing.push(`${stylesheet} -> ${reference}`)
      }
    }
  }

  assert.deepEqual(missing, [])
})
