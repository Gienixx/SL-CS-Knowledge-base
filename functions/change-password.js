export async function onRequestPost(context) {
  try {
    const { email, password } = await context.request.json()
    const cleanEmail = email.trim().toLowerCase()

    const usersResponse = await fetch(
      `${context.env.SUPABASE_URL}/auth/v1/admin/users`,
      {
        method: 'GET',
        headers: {
          apikey: context.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${context.env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    )

    const usersData = await usersResponse.json()

    const user = usersData.users?.find(
      item => item.email?.toLowerCase() === cleanEmail
    )

    if (!user) {
      return Response.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    const updateResponse = await fetch(
      `${context.env.SUPABASE_URL}/auth/v1/admin/users/${user.id}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          apikey: context.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${context.env.SUPABASE_SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify({
          password
        })
      }
    )

    const updateData = await updateResponse.json()

    if (!updateResponse.ok) {
      return Response.json(updateData, {
        status: updateResponse.status
      })
    }

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
