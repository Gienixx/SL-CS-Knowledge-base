export function canSubmitOwnScheduleRequest(access) {
  return access?.allowed === true && (access?.is_agent === true || access?.is_admin === true)
}

export function linkedScheduleProfileIds(access) {
  const profileId = access?.user_id
  if (
    access?.allowed !== true ||
    typeof profileId !== 'string' ||
    !profileId.trim() ||
    !Array.isArray(access.linked_profile_ids) ||
    !access.linked_profile_ids.includes(profileId)
  ) return []
  return [profileId]
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

