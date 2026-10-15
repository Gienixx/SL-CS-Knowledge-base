import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  WORKFORCE_PERMISSION_KEYS,
  LEGACY_ADMIN_PERMISSION_KEYS,
  hasWorkforcePermission,
  normalizeWorkforceAccess
} from '../shared/workforce-access.js'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const dockerAvailable = spawnSync('docker', ['image', 'inspect', 'postgres:17-alpine'], { stdio: 'ignore' }).status === 0
const ADMIN_WITHOUT_APPROVAL = '11111111-1111-1111-1111-111111111111'
const ADMIN_WITH_APPROVAL = '22222222-2222-2222-2222-222222222222'
const NON_ADMIN_WITH_APPROVAL = '33333333-3333-3333-3333-333333333333'
const INACTIVE_ADMIN = '44444444-4444-4444-4444-444444444444'

function psql(container, sql) {
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

function startPsql(container, sql) {
  const child = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let error = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { error += chunk })
  child.stdin.end(sql)
  return { child, get output() { return output }, get error() { return error } }
}

function callAs(userId, functionArgs) {
  return `select set_config('request.jwt.claim.sub','${userId}',false); select public.approve_dashboard_agent_identity(${functionArgs});`
}

test('dashboard identity approval is an independent, explicit Workforce permission', async () => {
  assert.ok(WORKFORCE_PERMISSION_KEYS.includes('approve_dashboard_identities'))
  assert.ok(!LEGACY_ADMIN_PERMISSION_KEYS.includes('approve_dashboard_identities'))
  const reportingAdmin = normalizeWorkforceAccess({
    user_id: ADMIN_WITHOUT_APPROVAL,
    is_active: true,
    base_role: 'admin',
    permissions: { view_workforce_reports: true }
  })
  assert.equal(hasWorkforcePermission(reportingAdmin, 'view_workforce_reports'), true)
  assert.equal(hasWorkforcePermission(reportingAdmin, 'approve_dashboard_identities'), false)

  const workforce = await read('workforce.html')
  const editor = await read('scripts/workforce.js')
  const invitation = await read('functions/create-user.js')
  const migration = await read('supabase/migrations/20261015113409_dashboard_identity_approval_workflow.sql')
  assert.equal((workforce.match(/value="approve_dashboard_identities"/g) || []).length, 1)
  assert.match(workforce, /id="permissionGrid"[\s\S]*value="approve_dashboard_identities"/)
  const invitePermissionGrid = workforce.match(/id="invitePermissionGrid"([\s\S]*?)<\/div>/)?.[1] || ''
  assert.doesNotMatch(invitePermissionGrid, /approve_dashboard_identities/)
  assert.match(editor, /if \(key !== 'approve_dashboard_identities'\) permissions\[key\] = true/)
  assert.match(invitation, /legacyAdmin && key !== 'approve_dashboard_identities'/)
  assert.match(migration, /'approve_dashboard_identities'::text/)
  assert.match(migration, /workforce_has_permission\('approve_dashboard_identities'\)/)
  assert.doesNotMatch(migration, /insert into public\.user_permissions[\s\S]{0,300}approve_dashboard_identities[\s\S]{0,120}true/i)
})

test('Reporting Operations requires one explicit, evidence-backed confirmation per mapping', async () => {
  const page = await read('reporting-operations.html')
  const ui = await read('scripts/reporting-operations.js')
  const migration = await read('supabase/migrations/20261015113409_dashboard_identity_approval_workflow.sql')
  assert.match(page, /Dashboard identity approvals/)
  assert.match(ui, /sourceAuthorized: authorizationInput\.checked/)
  assert.match(ui, /blankMetricsVerified: blankMetricsInput\.checked/)
  assert.match(ui, /p_source_evidence_reference: confirmation\.evidenceReference/)
  assert.match(ui, /Type \$\{mapping\.agent_key\} to confirm this single mapping/)
  assert.match(ui, /p_expected_updated_at: selected\.updated_at/)
  assert.match(migration, /p_source_authorized is distinct from true/)
  assert.match(migration, /p_october_11_blank_metrics_verified is distinct from true/)
})

test('PostgreSQL 17 enforces approval authorization, audit atomicity, stale state, and race safety', { skip: !dockerAvailable, timeout: 120000 }, async t => {
  const container = `slcs-dashboard-identity-approval-${process.pid}-${Date.now()}`
  const setup = await read('tests/fixtures/dashboard-identity-approval-setup.sql')
  const migration = await read('supabase/migrations/20261015113409_dashboard_identity_approval_workflow.sql')

  try {
    execFileSync('docker', ['run', '--detach', '--rm', '--name', container, '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine'], { stdio: 'ignore' })
    let ready = false
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (spawnSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-c', 'select 1'], { stdio: 'ignore' }).status === 0) { ready = true; break }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.ok(ready, 'disposable PostgreSQL 17 container became ready')
    psql(container, `${setup}\n${migration}`)

    assert.equal(psql(container, `select count(*) from public.user_permissions where permission_key='approve_dashboard_identities' and is_granted;`).trim(), '0', 'migration created no automatic grants')
    assert.equal(psql(container, `select public.workforce_has_permission('approve_dashboard_identities') from set_config('request.jwt.claim.sub','${ADMIN_WITHOUT_APPROVAL}',false);`).trim(), 'f', 'report-view access alone is insufficient')

    psql(container, `insert into public.user_permissions(user_id,permission_key,is_granted,granted_by,reason) values
      ('${NON_ADMIN_WITH_APPROVAL}','approve_dashboard_identities',true,'${ADMIN_WITH_APPROVAL}','explicit test grant'),
      ('${INACTIVE_ADMIN}','approve_dashboard_identities',true,'${ADMIN_WITH_APPROVAL}','explicit test grant');`)
    psql(container, `select public.workforce_admin_save_employee('${ADMIN_WITH_APPROVAL}','Admin','E-1','active','admin',null,null,'Asia/Manila','{"approve_dashboard_identities":true}'::jsonb,'test grant');`)
    assert.equal(psql(container, `select (public.workforce_get_current_access()->'permissions'->>'approve_dashboard_identities') from set_config('request.jwt.claim.sub','${ADMIN_WITH_APPROVAL}',false);`).trim(), 'true', 'workforce editor saves and access RPC returns the explicit permission')

    const timestamp = psql(container, `select to_char(updated_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') from public.agent_identity_map where agent_key='fixture-agent';`).trim()
    const base = `'fixture-agent','Fixture Agent','zd-fixture','${timestamp}'::timestamptz`
    const goodTail = `'reviewed source evidence 2026-10-15','drive://verified-source-record',true,true`
    const rejected = async sql => {
      const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      assert.notEqual(result.status, 0, 'unsafe approval request was rejected')
    }

    await rejected(callAs(ADMIN_WITHOUT_APPROVAL, `${base},'report view only','drive://source',true,true`))
    await rejected(callAs(NON_ADMIN_WITH_APPROVAL, `${base},'authorized grant','drive://source',true,true`))
    await rejected(callAs(INACTIVE_ADMIN, `${base},'authorized grant','drive://source',true,true`))
    await rejected(callAs(ADMIN_WITH_APPROVAL, `${base},'authorized grant','drive://source',false,true`))
    await rejected(callAs(ADMIN_WITH_APPROVAL, `${base},'authorized grant','drive://source',true,false`))
    assert.equal(psql(container, `select dashboard_sync_approved::text || ':' || (select count(*) from public.dashboard_identity_approval_audit) from public.agent_identity_map where agent_key='fixture-agent';`).trim(), 'false:0', 'failed authorization and attestations leave mapping and audit unchanged')

    assert.equal(psql(container, `select public.workforce_has_permission('approve_dashboard_identities') from set_config('request.jwt.claim.sub','${ADMIN_WITH_APPROVAL}',false);`).trim(), 't')

    await rejected(callAs(ADMIN_WITH_APPROVAL, `'fixture-agent','Changed name','zd-fixture','${timestamp}'::timestamptz,${goodTail}`))
    await rejected(callAs(ADMIN_WITH_APPROVAL, `'fixture-agent','Fixture Agent','wrong-zendesk','${timestamp}'::timestamptz,${goodTail}`))
    await rejected(callAs(ADMIN_WITH_APPROVAL, `'fixture-agent','Fixture Agent','zd-fixture',now() - interval '1 year',${goodTail}`))
    await rejected(callAs(ADMIN_WITH_APPROVAL, `'inactive-agent','Inactive Agent','zd-inactive','${timestamp}'::timestamptz,${goodTail}`))
    await rejected(callAs(ADMIN_WITH_APPROVAL, `'fixture-agent','Fixture Agent','zd-fixture','${timestamp}'::timestamptz,'too short','',true,true`))

    psql(container, callAs(ADMIN_WITH_APPROVAL, `${base},${goodTail}`))
    assert.equal(psql(container, `select agent_name || ':' || zendesk_agent_key || ':' || dashboard_sync_approved::text from public.agent_identity_map where agent_key='fixture-agent';`).trim(), 'Fixture Agent:zd-fixture:true', 'only approval state changed; stable identity fields remain unchanged')
    assert.equal(psql(container, `select count(*) from public.dashboard_identity_approval_audit where agent_key='fixture-agent' and actor_user_id='${ADMIN_WITH_APPROVAL}' and reason='reviewed source evidence 2026-10-15' and source_evidence_reference='drive://verified-source-record' and before_state->>'dashboard_sync_approved'='false' and after_state->>'dashboard_sync_approved'='true';`).trim(), '1', 'success atomically creates attributable before/after audit')
    await rejected(callAs(ADMIN_WITH_APPROVAL, `${base},${goodTail}`))
    assert.equal(psql(container, `select count(*) from public.dashboard_identity_approval_audit where agent_key='fixture-agent';`).trim(), '1', 'repeated approval does not create a second audit event')
    await rejected(`update public.dashboard_identity_approval_audit set reason='rewritten' where agent_key='fixture-agent';`)
    assert.equal(psql(container, `select reason from public.dashboard_identity_approval_audit where agent_key='fixture-agent';`).trim(), 'reviewed source evidence 2026-10-15', 'audit rows reject mutation')
    t.diagnostic('authorization, evidence, exact mapping, success, append-only audit and repeated-request cases passed')

    const raceTimestamp = psql(container, `select to_char(updated_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') from public.agent_identity_map where agent_key='race-agent';`).trim()
    psql(container, `create function public.test_delay_identity_update() returns trigger language plpgsql as $$ begin if old.agent_key='race-agent' then perform pg_sleep(1); end if; return new; end $$; create trigger test_delay_identity_update before update on public.agent_identity_map for each row execute function public.test_delay_identity_update();`)
    const raceArgs = `'race-agent','Race Agent','zd-race','${raceTimestamp}'::timestamptz,${goodTail}`
    const raceSql = `${callAs(ADMIN_WITH_APPROVAL, raceArgs)}\n`
    const first = startPsql(container, raceSql)
    const second = startPsql(container, raceSql)
    const results = await Promise.all([first, second].map(session => new Promise(resolve => session.child.once('exit', code => resolve({ code, output: session.output, error: session.error })))) )
    assert.equal(results.filter(result => result.code === 0).length, 1, 'only one competing approval succeeds')
    assert.equal(results.filter(result => result.code !== 0).length, 1, 'the concurrent repeat fails safely')
    assert.equal(psql(container, `select dashboard_sync_approved::text || ':' || (select count(*) from public.dashboard_identity_approval_audit where agent_key='race-agent') from public.agent_identity_map where agent_key='race-agent';`).trim(), 'true:1', 'concurrent approval leaves one state change and one audit event')
    t.diagnostic('concurrent approvals serialize on the mapping row and produce one audit record')
  } finally {
    spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' })
  }
})
