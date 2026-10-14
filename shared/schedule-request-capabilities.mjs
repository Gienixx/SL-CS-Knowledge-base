export function canSubmitOwnScheduleRequest(access) {
  return access?.allowed === true && (access?.is_agent === true || access?.is_admin === true)
}

export function linkedScheduleProfileIds(access) {
  if (access?.allowed !== true || !Array.isArray(access.linked_profile_ids)) return []
  return [...new Set(access.linked_profile_ids.filter(id => typeof id === 'string' && id.trim()))]
}

export function filterSchedulesToLinkedProfiles(schedules, profileIds) {
  const allowedProfileIds = new Set(
    Array.isArray(profileIds)
      ? profileIds.filter(id => typeof id === 'string' && id.trim())
      : []
  )
  if (!allowedProfileIds.size || !Array.isArray(schedules)) return []
  return schedules.filter(schedule => allowedProfileIds.has(schedule?.user_id))
}
