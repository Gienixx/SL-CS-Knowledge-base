export const WORKFORCE_PERMISSION_KEYS = Object.freeze([
  'manage_employees',
  'manage_schedules',
  'view_team_attendance',
  'approve_leave',
  'view_workforce_reports',
  'edit_articles',
  'manage_payroll'
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
  permissions = {}
} = {}) {
  if (isAdmin && isAgent) {
    return 'admin_agent'
  }

  if (isAdmin) {
    return 'admin'
  }

  if (isAgent && permissions.edit_articles === true) {
    return 'agent_editor'
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
  const authenticated = Boolean(user?.id || data.user_id)
  const isActive = data.is_active === true
  const isAdmin = isActive && data.is_admin === true
  const isAgent = isActive && data.is_agent === true

  if (isActive && data.can_edit_articles === true) {
    permissions.edit_articles = true
  }

  if (isActive && data.can_manage_payroll === true) {
    permissions.manage_payroll = true
  }

  return {
    authenticated,
    allowed: authenticated && isActive,
    source,
    user,
    user_id: data.user_id || user?.id || null,
    full_name: normalizeText(data.full_name),
    email: normalizeEmail(data.email || user?.email),
    employee_id: normalizeText(data.employee_id),
    employment_status: normalizeText(data.employment_status),
    is_active: isActive,
    base_role: normalizeText(data.base_role) || 'agent',
    is_admin: isAdmin,
    is_agent: isAgent,
    team_id: data.team_id || null,
    supervisor_id: data.supervisor_id || null,
    timezone: normalizeText(data.timezone) || 'Asia/Manila',
    permissions,
    can_edit_articles: permissions.edit_articles === true,
    can_manage_payroll: permissions.manage_payroll === true,
    legacy: data.legacy && typeof data.legacy === 'object'
      ? data.legacy
      : null,
    access_type: getWorkforceAccessType({
      is_admin: isAdmin,
      is_agent: isAgent,
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
        user_id: user?.id || null,
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
      user_id: user?.id || null,
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
      is_agent: true,
      timezone: 'Asia/Manila',
      permissions,
      can_edit_articles: permissions.edit_articles,
      can_manage_payroll: false,
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
