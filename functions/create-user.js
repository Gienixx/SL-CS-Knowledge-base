import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export async function onRequestPost(context) {
  try {
    const { email, password } = await context.request.json()

    const supabase = createClient(
      context.env.SUPABASE_URL,
      context.env.SUPABASE_SERVICE_ROLE_KEY
    )

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    })

    if (error) {
      return Response.json({ error: error.message }, { status: 400 })
    }

    return Response.json({ user: data.user })
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }
}
