import { supabase } from './supabaseClient.js?v=8'

const BLOCKED_ZENDESK_REPORTING_RPCS = new Set([
  'get_dashboard_filtered_data',
  'get_phase3_step7_agent_analytics',
  'get_sla_response_dashboard'
])

const emptyPayloadFor = functionName => {
  if (functionName === 'get_dashboard_filtered_data') {
    return { options: {} }
  }

  return {
    summary: {},
    trend: [],
    breakdowns: {},
    agents: [],
    options: {}
  }
}

const originalRpc = supabase.rpc.bind(supabase)

supabase.rpc = (functionName, parameters, options) => {
  if (BLOCKED_ZENDESK_REPORTING_RPCS.has(functionName)) {
    return Promise.resolve({
      data: emptyPayloadFor(functionName),
      error: null
    })
  }

  return originalRpc(functionName, parameters, options)
}

document.documentElement.dataset.reportingSource = 'google_sheet'

document.querySelectorAll('[data-dimension-filter]').forEach(field => {
  field.hidden = true
  field.querySelectorAll('select, input').forEach(control => {
    control.disabled = true
  })
})

const sourceBadge = document.getElementById('reportSourceBadge')
if (sourceBadge) sourceBadge.hidden = true
