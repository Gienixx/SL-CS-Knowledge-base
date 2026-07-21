import { access, cp, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const outputDirectory = resolve(root, 'dist')

const publicDirectories = [
  'assets',
  'images',
  'partials',
  'scripts',
  'styles'
]

const publicRootFiles = new Set([
  '_headers',
  '_redirects',
  '_routes.json',
  'apple-touch-icon.png',
  'favicon.ico',
  'manifest.json',
  'manifest.webmanifest',
  'robots.txt',
  'site.webmanifest'
])

const forbiddenDirectories = new Set([
  '.git',
  '.github',
  '.wrangler',
  'apps-script',
  'config',
  'docs',
  'functions',
  'node_modules',
  'supabase',
  'test',
  'tests',
  'tools'
])

const forbiddenRootFiles = new Set([
  '.dev.vars',
  'package-lock.json',
  'package.json',
  'README.md',
  'wrangler.json',
  'wrangler.jsonc',
  'wrangler.toml'
])

const forbiddenExtensions = new Set([
  '.gs',
  '.log',
  '.md',
  '.sql',
  '.toml'
])

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function copyIfPresent(relativePath) {
  const source = resolve(root, relativePath)
  if (!await exists(source)) return

  const destination = resolve(outputDirectory, relativePath)
  await mkdir(resolve(destination, '..'), { recursive: true })
  await cp(source, destination, { recursive: true })
}

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const fullPath = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesBelow(fullPath))
    else files.push(fullPath)
  }

  return files
}

function normalizedRelativePath(path) {
  return relative(outputDirectory, path).split(sep).join('/')
}

async function validateOutput() {
  if (!await exists(resolve(outputDirectory, 'index.html'))) {
    throw new Error('Production build is missing dist/index.html')
  }

  const unsafeFiles = []
  for (const path of await filesBelow(outputDirectory)) {
    const relativePath = normalizedRelativePath(path)
    const parts = relativePath.split('/')
    const fileName = parts.at(-1)
    const extension = extname(fileName).toLowerCase()
    const stats = await lstat(path)

    if (
      stats.isSymbolicLink() ||
      fileName.startsWith('.env') ||
      forbiddenRootFiles.has(relativePath) ||
      forbiddenExtensions.has(extension) ||
      parts.some(part => forbiddenDirectories.has(part))
    ) {
      unsafeFiles.push(relativePath)
    }
  }

  if (unsafeFiles.length) {
    throw new Error(`Unsafe files found in dist/:\n${unsafeFiles.map(path => `- ${path}`).join('\n')}`)
  }
}

async function build() {
  await rm(outputDirectory, { recursive: true, force: true })
  await mkdir(outputDirectory, { recursive: true })

  const rootEntries = await readdir(root, { withFileTypes: true })
  const rootHtmlFiles = rootEntries
    .filter(entry => entry.isFile() && entry.name.endsWith('.html'))
    .map(entry => entry.name)

  for (const file of rootHtmlFiles) await copyIfPresent(file)
  for (const file of publicRootFiles) await copyIfPresent(file)
  for (const directory of publicDirectories) await copyIfPresent(directory)

  await validateOutput()

  const fileCount = (await filesBelow(outputDirectory)).length
  console.log(`Built ${fileCount} production assets in dist/.`)
}

build().catch(error => {
  console.error('Production build failed.')
  console.error(error)
  process.exitCode = 1
})
