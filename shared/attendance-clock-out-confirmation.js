export function elapsedClockOutMinutes(clockIn, now = new Date()) {
  const startTime = new Date(clockIn).getTime()
  const endTime = now instanceof Date ? now.getTime() : new Date(now).getTime()
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) return 0
  return Math.floor((endTime - startTime) / 60000)
}

export function formatClockOutElapsed(minutes) {
  const safeMinutes = Math.max(0, Math.floor(Number(minutes) || 0))
  if (safeMinutes < 1) return 'less than a minute'
  const hours = Math.floor(safeMinutes / 60)
  const remainingMinutes = safeMinutes % 60
  const parts = []
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`)
  if (remainingMinutes) parts.push(`${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}`)
  return parts.join(' ')
}

export async function confirmClockOutIfNeeded({ clockIn, now = new Date(), requestConfirmation }) {
  const elapsedMinutes = elapsedClockOutMinutes(clockIn, now)
  return Boolean(await requestConfirmation(formatClockOutElapsed(elapsedMinutes)))
}
