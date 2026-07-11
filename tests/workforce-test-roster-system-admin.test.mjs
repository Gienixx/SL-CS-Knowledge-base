import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const migrationPath = 'supabase/migrations-legacy/2026070701_workforce_initial_roster_assignments.sql'
const verificationPath = 'supabase/verification/workforce_initial_roster_assignments_check.sql'

test('Step 3 migration targets only the five real internal testers', async () => {
  const migration = await read(migrationPath)

  for (const member of ['almar', 'arby', 'arez', 'gen', 'jean']) {
    assert.match(
      migration,
      new RegExp(`\\('${member}'\\s*,`),
      `${member} should be present in the five-person test roster`
    )
  }

  assert.match(migration, /Expected exactly five resolved test-roster users/)
  assert.match(migration, /dummy account[\s\S]*not modified/i)
  assert.doesNotMatch(migration, /\('kirby'\s*,/)
  assert.doesNotMatch(migration, /\('tommy'\s*,/)
  assert.doesNotMatch(migration, /\('jerson'\s*,/)
  assert.doesNotMatch(migration, /\('tristan'\s*,/)
  assert.doesNotMatch(migration, /\('amora'\s*,/)
  assert.doesNotMatch(migration, /\('ford'\s*,/)
})

test('Arby stays an agent while receiving hidden global system access', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /add column if not exists is_system_admin boolean not null default false/)
  assert.match(
    migration,
    /\('arby',\s*'agent',\s*true,\s*true,\s*'Support Team',\s*'almar',\s*true,\s*true,\s*true,\s*true,\s*true,\s*true,\s*true\)/
  )
  assert.match(migration, /profile\.base_role = 'admin'[\s\S]*profile\.is_system_admin is true/)
  assert.match(migration, /'is_system_admin', v_is_active and v_profile\.is_system_admin/)
  assert.match(migration, /if v_profile\.is_system_admin is true then[\s\S]*v_base_role := 'agent'[\s\S]*v_is_agent := true/)
  assert.match(migration, /if v_profile\.is_system_admin is true then[\s\S]*v_is_granted := true/)
})

test('Arez and Gen are explicit article editors and Jean remains regular', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /\('arez',\s*'agent',\s*true,\s*false,\s*'Cashout Team',\s*'almar',\s*false,\s*false,\s*false,\s*false,\s*false,\s*true,\s*false\)/
  )
  assert.match(
    migration,
    /\('gen',\s*'agent',\s*true,\s*false,\s*'Support Team',\s*'almar',\s*false,\s*false,\s*false,\s*false,\s*false,\s*true,\s*false\)/
  )
  assert.match(
    migration,
    /\('jean',\s*'agent',\s*true,\s*false,\s*'Support Team',\s*'almar',\s*false,\s*false,\s*false,\s*false,\s*false,\s*false,\s*false\)/
  )
})

test('visible access helpers hide the system administrator role', async () => {
  const [sharedAccess, workforceScript] = await Promise.all([
    read('shared/workforce-access.js'),
    read('scripts/workforce.js')
  ])

  assert.match(sharedAccess, /if \(isSystemAdmin\) \{\s*return 'regular_agent'/)
  assert.match(sharedAccess, /is_system_admin: isSystemAdmin/)
  assert.match(sharedAccess, /is_admin: baseRole === 'admin'/)

  assert.match(workforceScript, /is_system_admin: profile\.is_system_admin === true/)
  assert.match(workforceScript, /\.select\('[^']*is_system_admin[^']*'\)/)
  assert.match(workforceScript, /if \(editingSystemAdmin\)/)
  assert.match(workforceScript, /permissionInputs\.forEach\(input => \{\s*input\.checked = true\s*input\.disabled = true/)
})

test('verification checks the five testers and lists other profiles without failing', async () => {
  const verification = await read(verificationPath)

  assert.match(verification, /complete five-person test matrix: should return 5 rows/i)
  assert.match(verification, /Hidden system administrator constraints: should return 0 rows/i)
  assert.match(verification, /Profiles outside the five-person test roster are listed for confirmation/i)
  assert.match(verification, /dummy account should appear here/i)
  assert.match(verification, /internal_test_roster_assignment/)
})
