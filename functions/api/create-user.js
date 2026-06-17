import { createClient } from '@supabase/supabase-js'

export async function onRequestPost(context) {
  try {
    const { email, password } = await context.request.json()

    const supabase = createClient(
      context.env.https://kfhyckyrgplkqhsbuwnx.supabase.co,
      context.env.eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmaHlja3lyZ3Bsa3Foc2J1d254Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTYzNDAzMCwiZXhwIjoyMDk3MjEwMDMwfQ.ViKwUMvn_-RPIcohWriFadpp0HD6fyxWGz2nAbAZhPY
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
