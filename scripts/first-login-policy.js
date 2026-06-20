const FIRST_LOGIN_POLICY_START = Date.parse(
  '2026-06-20T16:00:00.000Z'
)

export function requiresFirstLoginPasswordChange(user) {
  if (!user) {
    return false
  }

  const metadata =
    user.user_metadata &&
    typeof user.user_metadata === 'object'
      ? user.user_metadata
      : {}

  if (metadata.password_change_completed === true) {
    return false
  }

  if (metadata.requires_password_change === true) {
    return true
  }

  const createdAt = Date.parse(user.created_at || '')

  return (
    Number.isFinite(createdAt) &&
    createdAt >= FIRST_LOGIN_POLICY_START
  )
}
