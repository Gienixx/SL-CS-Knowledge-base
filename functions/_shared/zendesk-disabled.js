const DISABLED_STATUS = 410

function jsonResponse(data, status = DISABLED_STATUS, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Reporting-Source': 'google_sheet',
      ...headers
    }
  })
}

export function zendeskIntegrationDisabledResponse() {
  return jsonResponse({
    success: false,
    code: 'zendesk_integration_disabled',
    error: 'Zendesk synchronization is disabled. Reporting now uses the Google Sheet data source only.',
    reportingSource: 'google_sheet',
    retryable: false
  })
}

export function zendeskMethodNotAllowedResponse() {
  return jsonResponse({
    success: false,
    code: 'method_not_allowed',
    error: 'Use POST to check the disabled Zendesk integration endpoint.'
  }, 405, { Allow: 'POST' })
}
