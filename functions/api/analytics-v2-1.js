import { requireWorkforcePermission, WorkforceAuthorizationError } from '../_shared/workforce-auth.js'
import { snapshot } from '../_shared/analytics-v2-1-snapshot.js'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    Vary: 'Authorization'
  } })
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    const response = json({ error: 'Method not allowed.' }, 405)
    response.headers.set('Allow', 'GET')
    return response
  }
  try {
    await requireWorkforcePermission(context, 'view_workforce_reports')
    return json(snapshot)
  } catch (error) {
    return json({ error: error instanceof WorkforceAuthorizationError && error.status < 500
      ? error.message : 'Unable to load the analytics preview.' },
    error instanceof WorkforceAuthorizationError ? error.status : 500)
  }
}
