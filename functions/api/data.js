import { createClient } from '@supabase/supabase-js'

export async function onRequest(context) {
  const supabase = createClient(
    context.env.https://kfhyckyrgplkqhsbuwnx.supabase.co,
    context.env.eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmaHlja3lyZ3Bsa3Foc2J1d254Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTYzNDAzMCwiZXhwIjoyMDk3MjEwMDMwfQ.ViKwUMvn_-RPIcohWriFadpp0HD6fyxWGz2nAbAZhPY
  )

  const { data, error } = await supabase.from('login').select('*')

  return Response.json({ data, error })
}
