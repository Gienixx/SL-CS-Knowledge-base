import {
  requireWorkforcePermission,
  WorkforceAuthorizationError
} from './_shared/workforce-auth.js'

const PROTECTED_ROUTES = Object.freeze({
  '/create-user': {
    methods: ['POST'],
    permission: 'manage_employees',
    requireAdmin: true
  },
  '/resend-invite': {
    methods: ['POST'],
    permission: 'manage_employees',
    requireAdmin: true
  },
  '/update-employee': {
    methods: ['POST'],
    permission: 'manage_employees',
    requireAdmin: true
  },
  '/employee-lifecycle': {
    methods: ['POST'],
    permission: 'manage_employees',
    requireAdmin: true
  },
  '/change-password': {
    methods: ['POST'],
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
  const method = context.request.method.toUpperCase()

  if (!route || !route.methods.includes(method)) {
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
