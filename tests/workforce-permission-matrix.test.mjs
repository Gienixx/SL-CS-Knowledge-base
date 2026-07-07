import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  WORKFORCE_PERMISSION_KEYS,
  getWorkforceAccessType,
  hasWorkforcePermission,
  normalizeWorkforceAccess
} from '../shared/workforce-access.js'
import { onRequest as workforceMiddleware } from '../functions/_middleware.js'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const emptyPermissions = () => Object.fromEntries(
  WORKFORCE_PERMISSION_KEYS.map(key => [key, false])
)

function accessPayload(overrides = {}) {
  return {
    user_id: overrides.user_id || '00000000-0000-4000-8000-000000000001',
    full_name: overrides.full_name || 'Permission Test User',
    email: overrides.email || 'permission-test@example.com',
    employee_id: overrides.employee_id || 'SL-TEST',
    employment_status: overrides.employment_status || 'active',
    is_active: overrides.is_active ?? true,
    base_role: overrides.base_role || 'agent',
    is_admin: overrides.is_admin ?? false,
    is_system_admin: overrides.is_system_admin ?? false,
    is_agent: overrides.is_agent ?? true,
    team_id: overrides.team_id || null,
    supervisor_id: overrides.supervisor_id || null,
    timezone: overrides.timezone || 'America/New_York',
    permissions: {
      ...emptyPermissions(),
      ...(overrides.permissions || {})
    }
  }
}

const fixtures = Object.freeze({
  adminAgent: accessPayload({
    user_id: '00000000-0000-4000-8000-000000000011',
    email: 'admin-agent@example.com',
    base_role: 'admin',
    is_admin: true,
    is_agent: true,
    permissions: {
      manage_employees: true,
      manage_schedules: true,
      view_team_attendance: true,
      approve_leave: true,
      view_workforce_reports: true
    }
  }),
  adminOnly: accessPayload({
    user_id: '00000000-0000-4000-8000-000000000012',
    email: 'admin-only@example.com',
    base_role: 'admin',
    is_admin: true,
    is_agent: false,
    permissions: {
      manage_employees: true,
      manage_schedules: true,
      view_team_attendance: true,
      approve_leave: true,
      view_workforce_reports: true
    }
  }),
  agentEditor: accessPayload({
    user_id: '00000000-0000-4000-8000-000000000013',
    email: 'agent-editor@example.com',
    permissions: { edit_articles: true }
  }),
  regularAgent: accessPayload({
    user_id: '00000000-0000-4000-8000-000000000014',
    email: 'regular-agent@example.com'
  }),
  supervisor: accessPayload({
    user_id: '00000000-0000-4000-8000-000000000015',
    email: 'supervisor@example.com',
    team_id: '00000000-0000-4000-8000-000000000099',
    permissions: {
      manage_schedules: true,
      view_team_attendance: true,
      approve_leave: true
    }
  })
})

function normalized(payload) {
  return normalizeWorkforceAccess(payload, {
    user: {
      id: payload.user_id,
      email: payload.email
    }
  })
}

function responseJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

async function runProtectedRoute(payload, {
  pathname = '/list-users',
  method = 'GET',
  includeToken = true
} = {}) {
  const originalFetch = globalThis.fetch
  let nextCalls = 0

  globalThis.fetch = async input => {
    const url = String(input)

    if (url.endsWith('/auth/v1/user')) {
      return responseJson({
        id: payload.user_id,
        email: payload.email
      })
    }

    if (url.endsWith('/rest/v1/rpc/workforce_get_current_access')) {
      return responseJson(payload)
    }

    throw new Error(`Unexpected permission-test request: ${url}`)
  }

  try {
    const headers = includeToken
      ? { Authorization: 'Bearer permission-test-token' }
      : undefined

    const response = await workforceMiddleware({
      request: new Request(`https://support.example${pathname}`, {
        method,
        headers
      }),
      env: {
        SUPABASE_URL: 'https://permission-test.supabase.co',
        SUPABASE_ANON_KEY: 'permission-test-anon-key',
        SUPABASE_SERVICE_ROLE_KEY: 'permission-test-service-role-key'
      },
      data: {},
      next: async () => {
        nextCalls += 1
        return new Response(null, { status: 204 })
      }
    })

    return { response, nextCalls }
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('all supported workforce user types map to the intended visible access type', () => {
  assert.equal(getWorkforceAccessType(normalized(fixtures.adminAgent)), 'admin_agent')
  assert.equal(getWorkforceAccessType(normalized(fixtures.adminOnly)), 'admin')
  assert.equal(getWorkforceAccessType(normalized(fixtures.agentEditor)), 'agent_editor')
  assert.equal(getWorkforceAccessType(normalized(fixtures.regularAgent)), 'regular_agent')
  assert.equal(getWorkforceAccessType(normalized(fixtures.supervisor)), 'regular_agent')
})

test('permission grants remain explicit for every user type', () => {
  const adminAgent = normalized(fixtures.adminAgent)
  const adminOnly = normalized(fixtures.adminOnly)
  const agentEditor = normalized(fixtures.agentEditor)
  const regularAgent = normalized(fixtures.regularAgent)
  const supervisor = normalized(fixtures.supervisor)

  for (const access of [adminAgent, adminOnly]) {
    assert.equal(hasWorkforcePermission(access, 'manage_employees'), true)
    assert.equal(hasWorkforcePermission(access, 'manage_schedules'), true)
    assert.equal(hasWorkforcePermission(access, 'view_team_attendance'), true)
    assert.equal(hasWorkforcePermission(access, 'approve_leave'), true)
    assert.equal(hasWorkforcePermission(access, 'view_workforce_reports'), true)
  }

  assert.equal(adminAgent.is_agent, true)
  assert.equal(adminOnly.is_agent, false)

  assert.equal(hasWorkforcePermission(agentEditor, 'edit_articles'), true)
  assert.equal(hasWorkforcePermission(agentEditor, 'manage_employees'), false)
  assert.equal(hasWorkforcePermission(agentEditor, 'manage_schedules'), false)

  for (const permission of WORKFORCE_PERMISSION_KEYS) {
    assert.equal(hasWorkforcePermission(regularAgent, permission), false)
  }

  assert.equal(supervisor.is_admin, false)
  assert.equal(hasWorkforcePermission(supervisor, 'manage_schedules'), true)
  assert.equal(hasWorkforcePermission(supervisor, 'view_team_attendance'), true)
  assert.equal(hasWorkforcePermission(supervisor, 'approve_leave'), true)
  assert.equal(hasWorkforcePermission(supervisor, 'manage_employees'), false)
  assert.equal(hasWorkforcePermission(supervisor, 'view_workforce_reports'), false)
})

test('inactive users and administrators with revoked grants are denied', () => {
  const inactiveAdmin = normalized(accessPayload({
    base_role: 'admin',
    is_admin: true,
    is_agent: true,
    is_active: false,
    employment_status: 'inactive',
    permissions: {
      manage_employees: true,
      manage_schedules: true
    }
  }))

  const revokedAdmin = normalized(accessPayload({
    base_role: 'admin',
    is_admin: true,
    is_agent: false,
    permissions: {
      manage_employees: false,
      manage_schedules: true
    }
  }))

  assert.equal(inactiveAdmin.allowed, false)
  assert.equal(hasWorkforcePermission(inactiveAdmin, 'manage_employees'), false)
  assert.equal(hasWorkforcePermission(revokedAdmin, 'manage_employees'), false)
  assert.equal(hasWorkforcePermission(revokedAdmin, 'manage_schedules'), true)
})

test('protected account-management endpoints require administrator scope and manage_employees', async () => {
  for (const fixture of [fixtures.adminAgent, fixtures.adminOnly]) {
    const allowed = await runProtectedRoute(fixture)
    assert.equal(allowed.response.status, 204)
    assert.equal(allowed.nextCalls, 1)
  }

  const revokedAdmin = await runProtectedRoute(accessPayload({
    base_role: 'admin',
    is_admin: true,
    is_agent: false,
    permissions: { manage_employees: false }
  }))
  assert.equal(revokedAdmin.response.status, 403)
  assert.equal(revokedAdmin.nextCalls, 0)

  const nonAdminWithGrant = await runProtectedRoute(accessPayload({
    base_role: 'agent',
    is_admin: false,
    is_agent: true,
    permissions: { manage_employees: true }
  }))
  assert.equal(nonAdminWithGrant.response.status, 403)
  assert.equal(nonAdminWithGrant.nextCalls, 0)

  const editor = await runProtectedRoute(fixtures.agentEditor)
  assert.equal(editor.response.status, 403)
  assert.equal(editor.nextCalls, 0)

  const anonymous = await runProtectedRoute(fixtures.regularAgent, {
    includeToken: false
  })
  assert.equal(anonymous.response.status, 401)
  assert.equal(anonymous.nextCalls, 0)
})

test('page guards enforce management, attendance, and schedule boundaries', async () => {
  const [workforce, teams, attendance, schedule, homeNav, middleware] = await Promise.all([
    read('scripts/workforce.js'),
    read('scripts/team-management.js'),
    read('scripts/attendance.js'),
    read('scripts/my-schedule-v2.js'),
    read('scripts/home-workforce-nav.js'),
    read('functions/_middleware.js')
  ])

  assert.match(workforce, /requireWorkforcePermission\(supabase,\s*'manage_employees'/)
  assert.match(workforce, /access\.is_admin !== true/)
  assert.match(teams, /requireWorkforcePermission\(supabase,\s*'manage_employees'/)
  assert.match(teams, /access\.is_admin !== true/)

  assert.match(attendance, /access\.is_agent !== true/)
  assert.match(attendance, /linked_profile_ids/)
  assert.match(attendance, /\.rpc\('workforce_clock_in'/)
  assert.match(attendance, /\.rpc\('workforce_clock_out'/)

  assert.match(schedule, /personalProfileIds/)
  assert.match(schedule, /query\s*=\s*query\.in\('user_id',\s*personalProfileIds\)/)
  assert.match(schedule, /access\.is_agent !== true && !canManageSchedules/)

  assert.match(homeNav, /access\.is_admin\s*===\s*true/)
  assert.match(homeNav, /hasWorkforcePermission\(access,\s*'manage_employees'\)/)
  assert.match(homeNav, /access\.is_agent\s*===\s*true/)

  assert.match(middleware, /permission:\s*'manage_employees'/)
  assert.match(middleware, /requireAdmin:\s*true/)
})

test('database artifacts retain RLS, supervisor scope, identity safety, and anonymous denial', async () => {
  const [foundation, permissionService, attendanceMigration] = await Promise.all([
    read('supabase/migrations/2026070601_workforce_foundation.sql'),
    read('supabase/migrations/2026070605_workforce_permission_service.sql'),
    read('supabase/migrations/2026070801_agent_attendance_interface.sql')
  ])

  for (const table of [
    'teams',
    'profiles',
    'user_permissions',
    'work_schedules',
    'attendance',
    'leave_requests',
    'workforce_audit_logs'
  ]) {
    assert.match(foundation, new RegExp(`alter table public\\.${table} enable row level security`, 'i'))
    assert.match(foundation, new RegExp(`revoke all on public\\.${table} from anon`, 'i'))
  }

  assert.match(foundation, /workforce_is_assigned_supervisor\(p_target_user_id uuid\)/)
  assert.match(foundation, /workforce_can_manage_user\(uuid, text\)/)
  assert.match(foundation, /auth\.uid\(\) = user_id/)
  assert.match(permissionService, /explicitly[\s\S]+granted permissions/i)
  assert.match(permissionService, /revoke execute[\s\S]+from anon/i)
  assert.match(attendanceMigration, /workforce_is_current_identity\(schedule\.user_id\)/)
  assert.match(attendanceMigration, /workforce_is_current_identity\(attendance_row\.user_id\)/)
})
