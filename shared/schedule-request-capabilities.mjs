export function canSubmitOwnScheduleRequest(access) {
  return access?.allowed === true && access?.is_agent === true
}
