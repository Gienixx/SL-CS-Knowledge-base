export async function onRequestPost(context) {
  try {
    const { email, password } = await context.request.json()

    // Create auth user
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
          email,
          password,
          email_confirm: true
        })
      }
    )

    const authData = await authResponse.json()

    if (!authResponse.ok) {
      return Response.json(authData, {
        status: authResponse.status
      })
    }

    // Insert into login table
    await fetch(
      `${context.env.SUPABASE_URL}/rest/v1/login`,
      {
        method: 'POST',
        headers: {
          apikey: context.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${context.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          id: authData.id,
          email: email
        })
      }
    )

    return Response.json({
      success: true
    })

  } catch (error) {
    return Response.json(
      { error: error.message },
      { status: 500 }
    )
  }
}
