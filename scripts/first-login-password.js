import { supabase } from './supabaseClient.js'

async function refreshInvitationPageState() {
  const {
    data: { user },
    error
  } = await supabase.auth.getUser()

  if (error) {
    console.warn(
      'Unable to read invitation state:',
      error
    )
    return
  }

  const params = new URLSearchParams(
    window.location.search
  )
  const metadata =
    user?.user_metadata &&
    typeof user.user_metadata === 'object'
      ? user.user_metadata
      : {}

  const invitationFlow =
    params.get('invite') === '1' ||
    params.get('firstLogin') === '1' ||
    metadata.requires_password_change === true

  if (!invitationFlow) {
    return
  }

  document.body.dataset.accountSetup = 'invite'
}

refreshInvitationPageState()
