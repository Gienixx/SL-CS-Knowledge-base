export function canAccessAdminToolPlayground(access) {
  // The playground is available to every authenticated workforce user.
  // The page still requires a valid active session through admin-tool-entry.js.
  return access?.allowed === true
}
