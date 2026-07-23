export const WORKFORCE_PERMISSION_KEYS = Object.freeze([
  'manage_employees',
  'manage_schedules',
  'view_team_attendance',
  'correct_attendance',
  'approve_attendance',
  'approve_leave',
  'view_workforce_reports',
  'manage_announcements',
  'edit_articles',
  'manage_agent_rates',
  'create_payroll',
  'review_payroll',
  'finalize_payroll',
  'view_all_payslips',
  'view_own_payslips',
  'export_payslips',
  'reopen_payroll',
  'manage_payroll'
])

export const PAYROLL_PERMISSION_KEYS = Object.freeze([
  'manage_agent_rates',
  'create_payroll',
  'review_payroll',
  'finalize_payroll',
  'view_all_payslips',
  'view_own_payslips',
  'export_payslips',
  'reopen_payroll'
])

export const LEGACY_ADMIN_PERMISSION_KEYS = Object.freeze([
  'manage_employees',
  'manage_schedules',
  'view_team_attendance',
  'approve_leave',
  'view_workforce_reports'
])

function toBoolean(value) {
  return value === true
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase()
}

function normalizeUuidList(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback
  return [...new Set(source.filter(item => typeof item === 'string' && item.trim()))]
}

export function createPermissionMap(source = {}) {
  const permissions = {}

  for (const key of WORKFORCE_PERMISSION_KEYS) {
    permissions[key] = toBoolean(source?.[key])
  }

  return permissions
}

export function getWorkforceAccessType({
  is_admin: isAdmin = false,
  is_agent: isAgent = false,
  is_system_admin: _isSystemAdmin = false,
  permissions: _permissions = {}
} = {}) {
  if (isAdmin && isAgent) {
    return 'admin_agent'
  }

  if (isAdmin) {
    return 'admin'
  }

  return 'regular_agent'
}

export function normalizeWorkforceAccess(
  payload,
  {
    user = null,
    source = 'workforce_rpc'
  } = {}
) {
  const data = payload && typeof payload === 'object'
    ? payload
    : {}

  const permissions = createPermissionMap(data.permissions)
  const authenticated = Boolean(user?.id || data.auth_user_id || data.user_id)
  const isActive = data.is_active === true
  const baseRole = normalizeText(data.base_role) || 'agent'
  const isSystemAdmin = isActive && data.is_system_admin === true
  const isAdmin = isActive && (
    data.is_admin === true ||
    isSystemAdmin
  )
  const isAgent = isActive && data.is_agent === true
  const resolvedUserId = data.user_id || user?.id || null
  const linkedProfileIds = normalizeUuidList(
    data.linked_profile_ids,
    resolvedUserId ? [resolvedUserId] : []
  )

  if (resolvedUserId && !linkedProfileIds.includes(resolvedUserId)) {
    linkedProfileIds.unshift(resolvedUserId)
  }

  if (isActive && data.can_edit_articles === true) {
    permissions.edit_articles = true
  }

  if (isActive && data.can_manage_payroll === true) {
    permissions.manage_payroll = true
  }

  if (isActive && data.can_correct_attendance === true) {
    permissions.correct_attendance = true
  }

  if (isActive && data.can_approve_attendance === true) {
    permissions.approve_attendance = true
  }

  return {
    authenticated,
    allowed: authenticated && isActive,
    source,
    user,
    auth_user_id: data.auth_user_id || user?.id || null,
    user_id: resolvedUserId,
    linked_profile_ids: linkedProfileIds,
    full_name: normalizeText(data.full_name),
    email: normalizeEmail(data.email || user?.email),
    employee_id: normalizeText(data.employee_id),
    employment_status: normalizeText(data.employment_status),
    is_active: isActive,
    base_role: baseRole,
    is_admin: isAdmin,
    is_system_admin: isSystemAdmin,
    is_agent: isAgent,
    team_id: data.team_id || null,
    supervisor_id: data.supervisor_id || null,
    timezone: normalizeText(data.timezone) || 'America/New_York',
    permissions,
    can_edit_articles: permissions.edit_articles === true,
    can_manage_announcements: permissions.manage_announcements === true,
    can_manage_payroll: permissions.manage_payroll === true,
    can_manage_agent_rates: permissions.manage_agent_rates === true,
    can_create_payroll: permissions.create_payroll === true,
    can_review_payroll: permissions.review_payroll === true,
    can_finalize_payroll: permissions.finalize_payroll === true,
    can_view_all_payslips: permissions.view_all_payslips === true,
    can_view_own_payslips: permissions.view_own_payslips === true,
    can_export_payslips: permissions.export_payslips === true,
    can_reopen_payroll: permissions.reopen_payroll === true,
    can_correct_attendance: permissions.correct_attendance === true,
    can_approve_attendance: permissions.approve_attendance === true,
    legacy: data.legacy && typeof data.legacy === 'object'
      ? data.legacy
      : null,
    access_type: getWorkforceAccessType({
      is_admin: baseRole === 'admin',
      is_agent: isAgent,
      is_system_admin: isSystemAdmin,
      permissions
    })
  }
}

export function createLegacyWorkforceAccess(
  loginRecord,
  {
    user = null,
    source = 'legacy_login'
  } = {}
) {
  const row = loginRecord && typeof loginRecord === 'object'
    ? loginRecord
    : null

  if (!row) {
    return normalizeWorkforceAccess(
      {
        auth_user_id: user?.id || null,
        user_id: user?.id || null,
        linked_profile_ids: user?.id ? [user.id] : [],
        email: user?.email || '',
        is_active: false,
        employment_status: 'inactive',
        permissions: {}
      },
      { user, source }
    )
  }

  const permissions = createPermissionMap()
  const isAdmin = row.is_admin === true

  if (isAdmin) {
    for (const key of LEGACY_ADMIN_PERMISSION_KEYS) {
      permissions[key] = true
    }
  }

  permissions.edit_articles = row.can_edit_articles === true

  const metadata = user?.user_metadata && typeof user.user_metadata === 'object'
    ? user.user_metadata
    : {}

  return normalizeWorkforceAccess(
    {
      auth_user_id: user?.id || null,
      user_id: user?.id || null,
      linked_profile_ids: user?.id ? [user.id] : [],
      full_name:
        normalizeText(row.name) ||
        normalizeText(metadata.full_name) ||
        normalizeText(metadata.name) ||
        normalizeEmail(row.email || user?.email).split('@')[0],
      email: row.email || user?.email || '',
      employee_id: '',
      employment_status: 'active',
      is_active: true,
      base_role: isAdmin ? 'admin' : 'agent',
      is_admin: isAdmin,
      is_system_admin: false,
      is_agent: true,
      timezone: 'America/New_York',
      permissions,
      can_edit_articles: permissions.edit_articles,
      can_manage_announcements: false,
      can_manage_payroll: false,
      can_manage_agent_rates: false,
      can_create_payroll: false,
      can_review_payroll: false,
      can_finalize_payroll: false,
      can_view_all_payslips: false,
      can_view_own_payslips: false,
      can_export_payslips: false,
      can_reopen_payroll: false,
      can_correct_attendance: false,
      can_approve_attendance: false,
      legacy: {
        is_admin: isAdmin,
        can_edit_articles: row.can_edit_articles === true
      }
    },
    { user, source }
  )
}

export function hasWorkforcePermission(access, permissionKey) {
  if (!WORKFORCE_PERMISSION_KEYS.includes(permissionKey)) {
    return false
  }

  return Boolean(
    access?.allowed === true &&
    access?.permissions?.[permissionKey] === true
  )
}
