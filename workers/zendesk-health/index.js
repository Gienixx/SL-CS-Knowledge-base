const STATUS = Object.freeze({
  success: true,
  enabled: false,
  code: 'zendesk_integration_disabled',
  reportingSource: 'google_sheet',
  message: 'Zendesk synchronization is disabled. The dashboard uses Google Sheet reporting data only.'
})

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Reporting-Source': 'google_sheet'
    }
  })
}

export default {
  async scheduled(controller) {
    console.log('Zendesk scheduled synchronization skipped.', {
      scheduledTime: controller?.scheduledTime || null,
      reportingSource: STATUS.reportingSource
    })
  },

  async fetch() {
    return jsonResponse(STATUS)
  }
}
