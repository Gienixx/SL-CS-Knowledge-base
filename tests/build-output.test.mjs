import assert from 'node:assert/strict'
import { access, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const execFileAsync = promisify(execFile)
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

test('production build publishes only browser assets', async () => {
  await execFileAsync(process.execPath, ['tools/build.mjs'], { cwd: root })

  const sourceHtmlFiles = (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.html'))
    .map(entry => entry.name)

  for (const htmlFile of sourceHtmlFiles) {
    assert.equal(await exists(`dist/${htmlFile}`), true, `${htmlFile} should be in dist/`)
  }

  for (const requiredPath of [
    'dist/index.html',
    'dist/partials',
    'dist/scripts',
    'dist/shared/workforce-access.js',
    'dist/styles'
  ]) {
    assert.equal(await exists(requiredPath), true, `${requiredPath} should exist`)
  }

  for (const forbiddenPath of [
    'dist/.github',
    'dist/.wrangler',
    'dist/apps-script',
    'dist/config',
    'dist/docs',
    'dist/functions',
    'dist/node_modules',
    'dist/supabase',
    'dist/tests',
    'dist/tools',
    'dist/scripts/build.mjs',
    'dist/package-lock.json',
    'dist/package.json',
    'dist/README.md',
    'dist/wrangler.toml'
  ]) {
    assert.equal(await exists(forbiddenPath), false, `${forbiddenPath} must not be published`)
  }

  const forbiddenExtensions = /\.(?:gs|log|md|sql|toml)$/i
  const unsafeFiles = (await filesBelow('dist')).filter(path => forbiddenExtensions.test(path))
  assert.deepEqual(unsafeFiles, [])
})
