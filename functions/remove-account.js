function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  })
}

function cleanEmail(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : ''
}

async function readResponse(response) {
  const text = await response.text()

  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function serviceFetch(url, key, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(options.headers || {})
    }
  })

  const data = await readResponse(response)

  if (!response.ok) {
    const error = new Error(
      data?.message ||
      data?.error ||
      'Supabase request failed.'
    )
    error.status = response.status
    throw error
  }

  return data
}

async function getAdminContext(context) {
  const authorization = context.request.headers.get('Authorization') || ''
  const accessToken = authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : ''

  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY
  } = context.env

  if (!accessToken) {
    const error = new Error('Authentication required.')
    error.status = 401
    throw error
  }

  const baseUrl = SUPABASE_URL.replace(/\/$/, '')
  const userResponse = await fetch(`${baseUrl}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`
    }
  })
  const signedInUser = await readResponse(userResponse)

  if (!userResponse.ok) {
    const error = new Error('Your session is invalid or has expired.')
    error.status = 401
    throw error
  }

  const adminEmail = cleanEmail(signedInUser?.email)
  const permissionUrl = new URL(`${baseUrl}/rest/v1/login`)
  permissionUrl.searchParams.set('select', 'is_admin')
  permissionUrl.searchParams.set('email', `eq.${adminEmail}`)
  permissionUrl.searchParams.set('limit', '1')

  const permissionRows = await serviceFetch(
    permissionUrl.toString(),
    SUPABASE_SERVICE_ROLE_KEY
  )

  if (!Array.isArray(permissionRows) || permissionRows[0]?.is_admin !== true) {
    const error = new Error('Administrator access required.')
    error.status = 403
    throw error
  }

  return {
    baseUrl,
    serviceKey: SUPABASE_SERVICE_ROLE_KEY,
    signedInUser
  }
}

async function findUserByEmail(baseUrl, serviceKey, email) {
  let page = 1

  while (true) {
    const url = new URL(`${baseUrl}/auth/v1/admin/users`)
    url.searchParams.set('page', String(page))
    url.searchParams.set('per_page', '1000')

    const result = await serviceFetch(url.toString(), serviceKey)
    const users = Array.isArray(result?.users) ? result.users : []
    const match = users.find(user => cleanEmail(user?.email) === email)

    if (match || users.length < 1000) {
      return match || null
    }

    page += 1
  }
}

export async function onRequestPost(context) {
  try {
    const admin = await getAdminContext(context)
    const body = await context.request.json()
    const email = cleanEmail(body.email)

    if (!email) {
      const error = new Error('A valid user email is required.')
      error.status = 400
      throw error
    }

    const authUser = await findUserByEmail(
      admin.baseUrl,
      admin.serviceKey,
      email
    )

    if (!authUser?.id) {
      const error = new Error(
        'The matching Supabase Authentication user was not found.'
      )
      error.status = 404
      throw error
    }

    if (
      cleanEmail(admin.signedInUser?.email) === email ||
      admin.signedInUser?.id === authUser.id
    ) {
      const error = new Error(
        'You cannot remove your own administrator account.'
      )
      error.status = 400
      throw error
    }

    await serviceFetch(
      `${admin.baseUrl}/auth/v1/admin/users/${encodeURIComponent(authUser.id)}`,
      admin.serviceKey,
      { method: 'DELETE' }
    )

    const loginUrl = new URL(`${admin.baseUrl}/rest/v1/login`)
    loginUrl.searchParams.set('email', `eq.${email}`)

    await serviceFetch(
      loginUrl.toString(),
      admin.serviceKey,
      {
        method: 'DELETE',
        headers: {
          Prefer: 'return=minimal'
        }
      }
    )

    return reply({
      success: true,
      removedFromAuthentication: true,
      removedFromLoginTable: true
    })
  } catch (error) {
    console.error('Remove-account function error:', error)

    return reply(
      { error: error.message || 'Unable to remove the account.' },
      Number.isInteger(error.status) ? error.status : 500
    )
  }
}
