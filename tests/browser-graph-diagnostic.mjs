import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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
      if (reference.startsWith('.') || reference.startsWith('/')) references.add(reference)
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
    } catch {}
  }
  throw new Error(`${importer} imports missing module ${reference}`)
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

async function run() {
  const entries = await browserEntryModules()
  const visited = new Set()
  const queue = [...entries]
  const edges = []
  while (queue.length) {
    const current = queue.shift()
    if (visited.has(current)) continue
    visited.add(current)
    const source = await readFile(pathFromRoot(current), 'utf8')
    for (const reference of localModuleReferences(source)) {
      const resolved = await resolveModule(current, reference)
      edges.push(`${current} -> ${resolved}`)
      if (!visited.has(resolved)) queue.push(resolved)
    }
  }
  const scripts = (await filesBelow('scripts')).filter(path => path.endsWith('.js'))
  const disconnected = scripts.filter(path => !visited.has(path)).sort()
  const report = [
    `Entries (${entries.length}):`, ...entries.sort(), '',
    `Disconnected (${disconnected.length}):`, ...disconnected, '',
    `Edges (${edges.length}):`, ...edges.sort(), ''
  ].join('\n')
  await writeFile(pathFromRoot('browser-graph-diagnostic.txt'), report)
  console.log(report)
}

run().catch(async error => {
  const report = `ERROR\n${error.stack || error.message || error}`
  await writeFile(pathFromRoot('browser-graph-diagnostic.txt'), report)
  console.error(report)
  process.exitCode = 1
})
