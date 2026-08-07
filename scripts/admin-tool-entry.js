import { supabase } from './supabaseClient.js?v=11'
import { loadCurrentWorkforceAccess } from './workforce-permissions.js?v=1'
import { canAccessAdminToolPlayground } from '../shared/admin-tool-access.js?v=1'

async function enforceAdminToolAccess() {
  try {
    const access = await loadCurrentWorkforceAccess(supabase, {
      allowLegacyFallback: false
    })

    if (!canAccessAdminToolPlayground(access)) {
      window.location.replace('./home.html')
      return
    }

    document.documentElement.dataset.adminToolAccess = 'allowed'
  } catch (error) {
    console.error('Admin Tool access verification failed:', error)
    window.location.replace('./home.html')
  }
}

enforceAdminToolAccess()
