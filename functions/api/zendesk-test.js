import {
  zendeskIntegrationDisabledResponse,
  zendeskMethodNotAllowedResponse
} from '../_shared/zendesk-disabled.js'

export function onRequestPost() {
  return zendeskIntegrationDisabledResponse()
}

export function onRequestGet() {
  return zendeskMethodNotAllowedResponse()
}
