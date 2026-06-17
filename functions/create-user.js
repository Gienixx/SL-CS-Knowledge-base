export async function onRequestPost(context) {
  try {
    const { email, password } = await context.request.json()
    const cleanEmail = email.trim().toLowerCase()

    const authResponse = await fetch(
      `${context.env.SUPABASE_URL}/auth/v1/admin/users`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: context.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${context.env.SUPABASE_SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify({
          email: cleanEmail,
          password,
          email_confirm: true
        })
      }
    )

    const authData = await authResponse.json()

    if (!authResponse.ok) {
      return Response.json(authData, { status: authResponse.status })
    }

    const loginResponse = await fetch(
      `${context.env.SUPABASE_URL}/rest/v1/login`,
      {
        method: 'POST',
        headers: {
          apikey: context.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${context.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          id: authData.id,
          email: cleanEmail
        })
      }
    )

    const loginData = await loginResponse.json()

    if (!loginResponse.ok) {
      return Response.json(
        {
          error: 'Auth user created, but login table insert failed.',
          details: loginData
        },
        { status: loginResponse.status }
      )
    }

    return Response.json({
      success: true,
      user: authData,
      login: loginData
    })

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }
}
