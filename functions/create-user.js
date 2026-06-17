export async function onRequestPost(context) {
  try {
    const { email, password } = await context.request.json()

    const response = await fetch(
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

    const result = await response.json()

    return Response.json(result, { status: response.status })
  } catch (error) {
    return Response.json(
      { error: error.message },
      { status: 500 }
    )
  }
}
