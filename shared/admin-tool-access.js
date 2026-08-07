const ADMIN_TOOL_PLAYGROUND_EMPLOYEE_ID = 'SL-81158E64'

export function canAccessAdminToolPlayground(access) {
  return access?.allowed === true && (
    access.is_admin === true ||
    access.is_system_admin === true ||
    access.employee_id === ADMIN_TOOL_PLAYGROUND_EMPLOYEE_ID
  )
}
