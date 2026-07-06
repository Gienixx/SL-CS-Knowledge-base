import {
  createLegacyWorkforceAccess,
  hasWorkforcePermission,
  normalizeWorkforceAccess
} from '../shared/workforce-access.js'

function normalizeEmail(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : ''
}

function isMissingAccessRpcError(error) {
  const code = String(error?.code || '').toUpperCase()
  const message = String(error?.message || '').toLowerCase()

  return (
    code === 'PGRST202' ||
    code === '42883' ||
    message.includes('workforce_get_current_access') &&
      (
        message.includes('not find') ||
        message.includes('does not exist') ||
        message.includes('schema cache')
      )
  )
}

async function loadLegacyAccess(supabase, user) {
  const email = normalizeEmail(user?.email)

  if (!email) {
    return createLegacyWorkforceAccess(null, { user })
  }

  const {
    data,
    error
  } = await supabase
    .from('login')
    .select('name, email, is_admin, can_edit_articles')
    .ilike('email', email)
    .maybeSingle()

  if (error) {
    throw error
  }

  return createLegacyWorkforceAccess(data, { user })
}

export async function loadCurrentWorkforceAccess(
  supabase,
  {
    session: providedSession = null,
    allowLegacyFallback = true
  } = {}
) {
  if (!supabase?.auth || typeof supabase.rpc !== 'function') {
    throw new TypeError('A Supabase client is required.')
  }

  let session = providedSession

  if (!session) {
    const {
      data,
      error
    } = await supabase.auth.getSession()

    if (error) {
      throw error
    }

    session = data?.session || null
  }

  const user = session?.user || null

  if (!user) {
    return {
      ...normalizeWorkforceAccess(null, {
        user: null,
        source: 'unauthenticated'
      }),
      session: null
    }
  }

  const {
    data,
    error
  } = await supabase.rpc('workforce_get_current_access')

  if (!error && data) {
    return {
      ...normalizeWorkforceAccess(data, { user }),
      session
    }
  }

  if (
    error &&
    (!allowLegacyFallback || !isMissingAccessRpcError(error))
  ) {
    throw error
  }

  if (!allowLegacyFallback) {
    return {
      ...normalizeWorkforceAccess(null, {
        user,
        source: 'workforce_rpc'
      }),
      session
    }
  }

  return {
    ...await loadLegacyAccess(supabase, user),
    session
  }
}

export async function requireWorkforcePermission(
  supabase,
  permissionKey,
  {
    session = null,
    loginPath = './login.html',
    deniedPath = './dashboard.html',
    returnTo = '',
    deniedMessage = 'You do not have permission to access this page.',
    navigate = path => window.location.replace(path),
    notify = message => window.alert(message)
  } = {}
) {
  const access = await loadCurrentWorkforceAccess(
    supabase,
    { session }
  )

  if (!access.authenticated) {
    const destination = returnTo
      ? `${loginPath}?returnTo=${encodeURIComponent(returnTo)}`
      : loginPath

    navigate(destination)
    return null
  }

  if (!hasWorkforcePermission(access, permissionKey)) {
    if (deniedMessage) {
      notify(deniedMessage)
    }

    navigate(deniedPath)
    return null
  }

  return access
}

export { hasWorkforcePermission }
