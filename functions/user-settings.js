function jsonResponse(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        'Content-Type':
          'application/json; charset=utf-8',

        'Cache-Control':
          'no-store'
      }
    }
  )
}

function getBearerToken(request) {
  const authorization =
    request.headers.get(
      'Authorization'
    )

  if (
    !authorization ||
    !authorization.startsWith(
      'Bearer '
    )
  ) {
    return null
  }

  return authorization
    .slice('Bearer '.length)
    .trim()
}

function getRequiredEnvironment(
  context
) {
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY
  } = context.env

  if (
    !SUPABASE_URL ||
    !SUPABASE_ANON_KEY ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error(
      'Supabase environment variables are incomplete.'
    )
  }

  return {
    supabaseUrl:
      SUPABASE_URL.endsWith('/')
        ? SUPABASE_URL.slice(0, -1)
        : SUPABASE_URL,

    anonKey:
      SUPABASE_ANON_KEY,

    serviceRoleKey:
      SUPABASE_SERVICE_ROLE_KEY
  }
}

async function parseResponseBody(
  response
) {
  const responseText =
    await response.text()

  if (!responseText) {
    return null
  }

  try {
    return JSON.parse(responseText)
  } catch {
    return responseText
  }
}

function getResponseError(
  data,
  fallback
) {
  if (
    data &&
    typeof data === 'object'
  ) {
    return (
      data.message ||
      data.error ||
      fallback
    )
  }

  if (
    typeof data === 'string' &&
    data.trim()
  ) {
    return data
  }

  return fallback
}

async function requireAdmin(
  context
) {
  const accessToken =
    getBearerToken(
      context.request
    )

  if (!accessToken) {
    return {
      authorized: false,

      response: jsonResponse(
        {
          error:
            'Authentication required.'
        },
        401
      )
    }
  }

  const {
    supabaseUrl,
    anonKey,
    serviceRoleKey
  } = getRequiredEnvironment(
    context
  )

  const userResponse =
    await fetch(
      `${supabaseUrl}/auth/v1/user`,
      {
        headers: {
          apikey:
            anonKey,

          Authorization:
            `Bearer ${accessToken}`
        }
      }
    )

  const authenticatedUser =
    await parseResponseBody(
      userResponse
    )

  if (!userResponse.ok) {
    return {
      authorized: false,

      response: jsonResponse(
        {
          error:
            'Your session is invalid or has expired.'
        },
        401
      )
    }
  }

  const authenticatedEmail =
    typeof authenticatedUser?.email ===
      'string'
      ? authenticatedUser.email
          .trim()
          .toLowerCase()
      : ''

  if (!authenticatedEmail) {
    return {
      authorized: false,

      response: jsonResponse(
        {
          error:
            'The authenticated account has no email address.'
        },
        401
      )
    }
  }

  const permissionUrl =
    new URL(
      `${supabaseUrl}/rest/v1/login`
    )

  permissionUrl.searchParams.set(
    'select',
    'is_admin'
  )

  permissionUrl.searchParams.set(
    'email',
    `eq.${authenticatedEmail}`
  )

  permissionUrl.searchParams.set(
    'limit',
    '1'
  )

  const permissionResponse =
    await fetch(
      permissionUrl.toString(),
      {
        headers: {
          apikey:
            serviceRoleKey,

          Authorization:
            `Bearer ${serviceRoleKey}`
        }
      }
    )

  const permissionRows =
    await parseResponseBody(
      permissionResponse
    )

  if (!permissionResponse.ok) {
    console.error(
      'Admin permission lookup failed:',
      permissionRows
    )

    return {
      authorized: false,

      response: jsonResponse(
        {
          error:
            'Unable to verify administrator permissions.'
        },
        500
      )
    }
  }

  if (
    !Array.isArray(permissionRows) ||
    permissionRows[0]
      ?.is_admin !== true
  ) {
    return {
      authorized: false,

      response: jsonResponse(
        {
          error:
            'Administrator access required.'
        },
        403
      )
    }
  }

  return {
    authorized: true,
    supabaseUrl,
    serviceRoleKey,
    authenticatedEmail
  }
}

async function getUserSettings(
  supabaseUrl,
  serviceRoleKey,
  email
) {
  const userUrl =
    new URL(
      `${supabaseUrl}/rest/v1/login`
    )

  userUrl.searchParams.set(
    'select',
    'email,is_admin,can_edit_articles'
  )

  userUrl.searchParams.set(
    'email',
    `eq.${email}`
  )

  userUrl.searchParams.set(
    'limit',
    '1'
  )

  const response =
    await fetch(
      userUrl.toString(),
      {
        headers: {
          apikey:
            serviceRoleKey,

          Authorization:
            `Bearer ${serviceRoleKey}`
        }
      }
    )

  const responseData =
    await parseResponseBody(response)

  if (!response.ok) {
    throw new Error(
      getResponseError(
        responseData,
        'Unable to retrieve user settings.'
      )
    )
  }

  if (
    !Array.isArray(responseData) ||
    responseData.length === 0
  ) {
    return null
  }

  return responseData[0]
}

async function updateUserSettings(
  supabaseUrl,
  serviceRoleKey,
  email,
  isAdmin,
  canEditArticles
) {
  const updateUrl =
    new URL(
      `${supabaseUrl}/rest/v1/login`
    )

  updateUrl.searchParams.set(
    'email',
    `eq.${email}`
  )

  const response =
    await fetch(
      updateUrl.toString(),
      {
        method: 'PATCH',

        headers: {
          'Content-Type':
            'application/json',

          Prefer:
            'return=representation',

          apikey:
            serviceRoleKey,

          Authorization:
            `Bearer ${serviceRoleKey}`
        },

        body: JSON.stringify({
          is_admin:
            isAdmin,

          can_edit_articles:
            canEditArticles
        })
      }
    )

  const responseData =
    await parseResponseBody(response)

  if (!response.ok) {
    throw new Error(
      getResponseError(
        responseData,
        'Unable to update user settings.'
      )
    )
  }

  if (
    !Array.isArray(responseData) ||
    responseData.length === 0
  ) {
    return null
  }

  return responseData[0]
}

export async function onRequestPost(
  context
) {
  try {
    const adminCheck =
      await requireAdmin(context)

    if (!adminCheck.authorized) {
      return adminCheck.response
    }

    let requestBody

    try {
      requestBody =
        await context.request.json()
    } catch {
      return jsonResponse(
        {
          error:
            'The request body must contain valid JSON.'
        },
        400
      )
    }

    const action =
      typeof requestBody.action ===
        'string'
        ? requestBody.action
            .trim()
            .toLowerCase()
        : ''

    const email =
      typeof requestBody.email ===
        'string'
        ? requestBody.email
            .trim()
            .toLowerCase()
        : ''

    if (!email) {
      return jsonResponse(
        {
          error:
            'A valid user email is required.'
        },
        400
      )
    }

    if (
      action !== 'get' &&
      action !== 'update'
    ) {
      return jsonResponse(
        {
          error:
            'A valid settings action is required.'
        },
        400
      )
    }

    const {
      supabaseUrl,
      serviceRoleKey,
      authenticatedEmail
    } = adminCheck

    const existingUser =
      await getUserSettings(
        supabaseUrl,
        serviceRoleKey,
        email
      )

    if (!existingUser) {
      return jsonResponse(
        {
          error:
            'User not found in the login table.'
        },
        404
      )
    }

    if (action === 'get') {
      return jsonResponse({
        success: true,

        user: {
          email:
            existingUser.email,

          is_admin:
            existingUser.is_admin ===
            true,

          can_edit_articles:
            existingUser
              .can_edit_articles ===
            true
        }
      })
    }

    if (
      typeof requestBody.isAdmin !==
        'boolean' ||
      typeof requestBody
        .canEditArticles !==
        'boolean'
    ) {
      return jsonResponse(
        {
          error:
            'Administrator and editor settings must be true or false.'
        },
        400
      )
    }

    const isAdmin =
      requestBody.isAdmin

    const canEditArticles =
      requestBody.canEditArticles

    if (
      email === authenticatedEmail &&
      isAdmin !== true
    ) {
      return jsonResponse(
        {
          error:
            'You cannot remove administrator access from your own account.'
        },
        400
      )
    }

    const updatedUser =
      await updateUserSettings(
        supabaseUrl,
        serviceRoleKey,
        email,
        isAdmin,
        canEditArticles
      )

    if (!updatedUser) {
      return jsonResponse(
        {
          error:
            'User not found in the login table.'
        },
        404
      )
    }

    return jsonResponse({
      success: true,

      user: {
        email:
          updatedUser.email,

        is_admin:
          updatedUser.is_admin ===
          true,

        can_edit_articles:
          updatedUser
            .can_edit_articles ===
          true
      }
    })
  } catch (error) {
    console.error(
      'User-settings function error:',
      error
    )

    return jsonResponse(
      {
        error:
          error.message ||
          'Unable to manage user settings.'
      },
      500
    )
  }
}
