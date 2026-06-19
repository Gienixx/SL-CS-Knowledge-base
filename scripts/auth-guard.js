import { supabase } from './supabaseClient.js'

async function requireAuthentication() {
  try {
    const {
      data: { user },
      error
    } = await supabase.auth.getUser()

    if (error) {
      console.error('Authentication check failed:', error)
      window.location.replace('./login.html')
      return
    }

    if (!user) {
      window.location.replace('./login.html')
    }
  } catch (error) {
    console.error('Authentication guard error:', error)
    window.location.replace('./login.html')
  }
}

requireAuthentication()
