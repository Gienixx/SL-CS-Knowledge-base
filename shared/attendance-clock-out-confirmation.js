export const CLOCK_OUT_CONFIRMATION_THRESHOLD_MINUTES = 10

export function elapsedClockOutMinutes(clockIn, now = new Date()) {
  const startTime = new Date(clockIn).getTime()
  const endTime = now instanceof Date ? now.getTime() : new Date(now).getTime()
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) return 0
  return Math.floor((endTime - startTime) / 60000)
}

export function shouldConfirmClockOut(clockIn, now = new Date()) {
  return elapsedClockOutMinutes(clockIn, now) < CLOCK_OUT_CONFIRMATION_THRESHOLD_MINUTES
}

export function formatClockOutElapsed(minutes) {
  const safeMinutes = Math.max(0, Math.floor(Number(minutes) || 0))
  if (safeMinutes < 1) return 'less than a minute'
  return `${safeMinutes} minute${safeMinutes === 1 ? '' : 's'}`
}

export async function confirmClockOutIfNeeded({ clockIn, now = new Date(), requestConfirmation }) {
  const elapsedMinutes = elapsedClockOutMinutes(clockIn, now)
  if (elapsedMinutes >= CLOCK_OUT_CONFIRMATION_THRESHOLD_MINUTES) return true
  return Boolean(await requestConfirmation(formatClockOutElapsed(elapsedMinutes)))
}
