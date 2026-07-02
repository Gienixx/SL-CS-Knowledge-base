export const PHASE3_REPORTING_SOURCE_POLICY = Object.freeze({
  key: 'phase3_step8_google_sheet_cutover',
  reportingSource: 'google_sheet',
  zendeskIntegrationEnabled: false,
  zendeskSyncEndpointsEnabled: false,
  zendeskReportingEnabled: false,
  preserveZendeskTables: true,
  preserveZendeskMigrations: true,
  disableUserFacingZendeskViews: true,
  notes: Object.freeze([
    'Google Sheet data is the only active reporting source.',
    'Zendesk synchronization, backfill, health testing, and scheduled processing are disabled.',
    'Existing Zendesk tables and migrations are retained temporarily for rollback and audit purposes.',
    'No Zendesk-derived source badge, mapping warning, or detailed filter is shown in the active reporting interface.'
  ])
})

export function validatePhase3ReportingSourcePolicy() {
  const policy = PHASE3_REPORTING_SOURCE_POLICY
  const errors = []

  if (policy.reportingSource !== 'google_sheet') {
    errors.push('Phase 3 reporting must use Google Sheet data only.')
  }

  if (
    policy.zendeskIntegrationEnabled ||
    policy.zendeskSyncEndpointsEnabled ||
    policy.zendeskReportingEnabled
  ) {
    errors.push('All Zendesk runtime paths must remain disabled during the cutover.')
  }

  if (!policy.preserveZendeskTables || !policy.preserveZendeskMigrations) {
    errors.push('Zendesk storage must remain preserved until the later cleanup phase.')
  }

  return errors
}
