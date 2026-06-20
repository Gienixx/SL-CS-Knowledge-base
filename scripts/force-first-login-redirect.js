import { supabase } from './supabaseClient.js'
import { requiresFirstLoginPasswordChange } from './first-login-policy.js?v=2'

const { data: { user } } = await supabase.auth.getUser()

if (requiresFirstLoginPasswordChange(user)) {
  window.location.replace('./change-password.html?firstLogin=1')
}
