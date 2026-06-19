function jsonResponse(data, status = 200) {
return new Response(JSON.stringify(data), {
status,
headers: {
'Content-Type': 'application/json; charset=utf-8',
'Cache-Control': 'no-store'
}
})
}

function getBearerToken(request) {
const authorization =
request.headers.get('Authorization')

if (
!authorization ||
!authorization.startsWith('Bearer ')
) {
return null
}

return authorization
.slice('Bearer '.length)
.trim()
}

function getRequiredEnvironment(context) {
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
supabaseUrl: SUPABASE_URL.endsWith('/')
? SUPABASE_URL.slice(0, -1)
: SUPABASE_URL,

 
anonKey: SUPABASE_ANON_KEY,

serviceRoleKey:
  SUPABASE_SERVICE_ROLE_KEY
 

}
}

async function requireAdmin(context) {
const accessToken =
getBearerToken(context.request)

if (!accessToken) {
return {
authorized: false,

 
  response: jsonResponse(
    {
      error: 'Authentication required.'
    },
    401
  )
}
 

}

const {
supabaseUrl,
anonKey,
serviceRoleKey
} = getRequiredEnvironment(context)

const userResponse = await fetch(
`${supabaseUrl}/auth/v1/user`,
{
headers: {
apikey: anonKey,
Authorization:
`Bearer ${accessToken}`
}
}
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

const authenticatedUser =
await userResponse.json()

const email =
authenticatedUser.email
?.trim()
.toLowerCase()

if (!email) {
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
`eq.${email}`
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
apikey: serviceRoleKey,

 
      Authorization:
        `Bearer ${serviceRoleKey}`
    }
  }
)
 

if (!permissionResponse.ok) {
console.error(
'Admin permission lookup failed:',
await permissionResponse.text()
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

const permissionRows =
await permissionResponse.json()

if (
!Array.isArray(permissionRows) ||
permissionRows[0]?.is_admin !== true
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
serviceRoleKey
}
}

async function findUserByEmail(
supabaseUrl,
serviceRoleKey,
targetEmail
) {
const perPage = 1000
let page = 1

while (page <= 20) {
const usersUrl =
new URL(
`${supabaseUrl}/auth/v1/admin/users`
)

 
usersUrl.searchParams.set(
  'page',
  String(page)
)

usersUrl.searchParams.set(
  'per_page',
  String(perPage)
)

const usersResponse =
  await fetch(
    usersUrl.toString(),
    {
      headers: {
        apikey: serviceRoleKey,

        Authorization:
          `Bearer ${serviceRoleKey}`
      }
    }
  )

const usersData =
  await usersResponse.json()

if (!usersResponse.ok) {
  throw new Error(
    usersData.message ||
    usersData.error ||
    'Unable to retrieve users.'
  )
}

const users =
  Array.isArray(usersData.users)
    ? usersData.users
    : []

const matchingUser =
  users.find(user => {
    return (
      user.email
        ?.trim()
        .toLowerCase() ===
      targetEmail
    )
  })

if (matchingUser) {
  return matchingUser
}

if (users.length < perPage) {
  return null
}

page += 1
 

}

return null
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

const email =
  typeof requestBody.email ===
  'string'
    ? requestBody.email
        .trim()
        .toLowerCase()
    : ''

const password =
  typeof requestBody.password ===
  'string'
    ? requestBody.password
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

if (password.length < 8) {
  return jsonResponse(
    {
      error:
        'The new password must contain at least 8 characters.'
    },
    400
  )
}

const {
  supabaseUrl,
  serviceRoleKey
} = adminCheck

const targetUser =
  await findUserByEmail(
    supabaseUrl,
    serviceRoleKey,
    email
  )

if (!targetUser) {
  return jsonResponse(
    {
      error: 'User not found.'
    },
    404
  )
}

const updateResponse =
  await fetch(
    `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(targetUser.id)}`,
    {
      method: 'PUT',

      headers: {
        'Content-Type':
          'application/json',

        apikey: serviceRoleKey,

        Authorization:
          `Bearer ${serviceRoleKey}`
      },

      body: JSON.stringify({
        password
      })
    }
  )

const updateData =
  await updateResponse.json()

if (!updateResponse.ok) {
  return jsonResponse(
    {
      error:
        updateData.message ||
        updateData.error ||
        'Unable to change the password.'
    },
    updateResponse.status
  )
}

return jsonResponse({
  success: true
})
 

} catch (error) {
console.error(
'Change-password function error:',
error
)

 
return jsonResponse(
  {
    error:
      error.message ||
      'Unable to change the password.'
  },
  500
)
 

}
}
