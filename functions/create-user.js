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

async function deleteAuthUser(
supabaseUrl,
serviceRoleKey,
userId
) {
if (!userId) {
return
}

try {
const response = await fetch(
`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
{
method: 'DELETE',

 
    headers: {
      apikey: serviceRoleKey,

      Authorization:
        `Bearer ${serviceRoleKey}`
    }
  }
)

if (!response.ok) {
  console.error(
    'Unable to roll back Auth user:',
    await response.text()
  )
}
 

} catch (error) {
console.error(
'Unable to roll back Auth user:',
error
)
}
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

const name =
  typeof requestBody.name ===
  'string'
    ? requestBody.name.trim()
    : ''
 
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
 const isAdmin =
  requestBody.isAdmin === true

const canEditArticles =
  requestBody.canEditArticles === true

if (!name) {
  return jsonResponse(
    {
      error:
        'A user name is required.'
    },
    400
  )
}
 
if (!email) {
  return jsonResponse(
    {
      error:
        'A valid email address is required.'
    },
    400
  )
}

if (password.length < 8) {
  return jsonResponse(
    {
      error:
        'The temporary password must contain at least 8 characters.'
    },
    400
  )
}

const {
  supabaseUrl,
  serviceRoleKey
} = adminCheck

const authResponse = await fetch(
  `${supabaseUrl}/auth/v1/admin/users`,
  {
    method: 'POST',

    headers: {
      'Content-Type':
        'application/json',

      apikey: serviceRoleKey,

      Authorization:
        `Bearer ${serviceRoleKey}`
    },

    body: JSON.stringify({
      email,
      password,
      email_confirm: true,

      user_metadata: {
        name
     }
   })

const authData =
  await authResponse.json()

if (!authResponse.ok) {
  return jsonResponse(
    {
      error:
        authData.message ||
        authData.error ||
        'Unable to create the Auth user.'
    },
    authResponse.status
  )
}

const loginResponse = await fetch(
  `${supabaseUrl}/rest/v1/login`,
  {
    method: 'POST',

    headers: {
      'Content-Type':
        'application/json',

      Prefer:
        'return=representation',

      apikey: serviceRoleKey,

      Authorization:
        `Bearer ${serviceRoleKey}`
    },

    body: JSON.stringify({
      name,
      email,
      is_admin: isAdmin,
      can_edit_articles: canEditArticles
    })

const loginResponseText =
  await loginResponse.text()

let loginData = null

if (loginResponseText) {
  try {
    loginData =
      JSON.parse(loginResponseText)
  } catch {
    loginData =
      loginResponseText
  }
}

if (!loginResponse.ok) {
  await deleteAuthUser(
    supabaseUrl,
    serviceRoleKey,
    authData.id
  )

  console.error(
    'Login table insert failed:',
    loginData
  )

  return jsonResponse(
    {
      error:
        'The user could not be added to the login table. The Auth user was rolled back.'
    },
    loginResponse.status
  )
}

return jsonResponse({
  success: true,

  user: {
  id: authData.id,
  name,
  email: authData.email
}
 

} catch (error) {
console.error(
'Create-user function error:',
error
)

 
return jsonResponse(
  {
    error:
      error.message ||
      'Unable to create the user.'
  },
  500
)
 

}
}
