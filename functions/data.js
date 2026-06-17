import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = 'https://kfhyckyrgplkqhsbuwnx.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmaHlja3lyZ3Bsa3Foc2J1d254Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzQwMzAsImV4cCI6MjA5NzIxMDAzMH0.fx_VADGD6VWoRjV_Sk25rMVrVjWCiYugw2oYS2D8Rpo'

export const supabase = createClient(
  supabaseUrl,
  supabaseAnonKey
)
