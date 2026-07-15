import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const exists = path => access(new URL(`../${path}`, import.meta.url))
  .then(() => true, () => false)

test('Step 10 retires User Management and its legacy endpoints', async () => {
  const [html, home, middleware, employeeUpdate] = await Promise.all([
    read('user-management.html'),
    read('home.html'),
    read('functions/_middleware.js'),
    read('functions/update-employee.js')
  ])

  assert.match(html, /window\.location\.replace\('\.\/workforce\.html'\)/)
  assert.doesNotMatch(home, /user-management\.html|homeUserManagementBtn/)
  assert.doesNotMatch(middleware, /list-users|user-settings|remove-account|delete-user/)
  for (const path of [
    'scripts/user-management.js',
    'styles/user-management.css',
    'functions/list-users.js',
    'functions/user-settings.js',
    'functions/remove-account.js',
    'functions/delete-user.js'
  ]) assert.equal(await exists(path), false, `${path} should be retired`)
  assert.match(employeeUpdate, /Compatibility parity verification failed/)
})
