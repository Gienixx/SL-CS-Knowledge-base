import {
  requireWorkforcePermission,
  WorkforceAuthorizationError
} from './_shared/workforce-auth.js'

const PROTECTED_ROUTES = Object.freeze({
  '/list-users': {
    permission: 'manage_employees',
    requireAdmin: true
  },
  '/create-user': {
    permission: 'manage_employees',
    requireAdmin: true
  },
  '/user-settings': {
    permission: 'manage_employees',
    requireAdmin: true
  },
  '/remove-account': {
    permission: 'manage_employees',
    requireAdmin: true
  },
  '/delete-user': {
    permission: 'manage_employees',
    requireAdmin: true
  },
  '/change-password': {
    permission: 'manage_employees',
    requireAdmin: true
  }
})

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  })
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return context.next()
  }

  const pathname = new URL(context.request.url).pathname
  const route = PROTECTED_ROUTES[pathname]

  if (!route) {
    return context.next()
  }

  try {
    const authorization = await requireWorkforcePermission(
      context,
      route.permission,
      { requireAdmin: route.requireAdmin }
    )

    context.data.workforceAuthorization = authorization
    return context.next()
  } catch (error) {
    console.error('Workforce authorization middleware error:', error)

    const status = error instanceof WorkforceAuthorizationError &&
      Number.isInteger(error.status)
      ? error.status
      : 500

    return jsonResponse(
      {
        error: status === 500
          ? 'Unable to verify workforce permissions.'
          : error.message
      },
      status
    )
  }
}
