export const PASSWORD_MIN_LENGTH = 8

export function evaluatePassword(value = '') {
  const password = String(value)
  const checks = {
    hasLength: password.length >= PASSWORD_MIN_LENGTH,
    hasMixedCase: /[a-z]/.test(password) && /[A-Z]/.test(password),
    hasNumber: /[0-9]/.test(password)
  }

  const score = Object.values(checks).filter(Boolean).length
  const label = !password
    ? 'Enter a password'
    : score <= 1 ? 'Weak' : score === 2 ? 'Good' : 'Strong'

  return {
    checks,
    score,
    label,
    valid: score === 3
  }
}

export function passwordsMatch(password, confirmation) {
  return Boolean(confirmation) && password === confirmation
}
