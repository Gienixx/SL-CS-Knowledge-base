import { createClient } from '@supabase/supabase-js'

export async function onRequest(context) {
  const supabase = createClient(
    context.env.SUPABASE_URL,
    context.env.SUPABASE_SERVICE_ROLE_KEY
  )

  const { data, error } = await supabase.from('your_table').select('*')

  return Response.json({ data, error })
}