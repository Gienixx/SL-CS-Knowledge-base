import { supabase } from './supabaseClient.js?v=9'

const DISPLAY_TARGETS = Object.freeze({
  homeFirstName: value => value,
  homeUserName: value => value,
  homeUserAvatar: value => value.charAt(0).toUpperCase() || 'CS'
})

document.addEventListener('DOMContentLoaded', initializeHomeUserName)

async function initializeHomeUserName() {
  try {
    const {
      data: { user },
      error: userError
    } = await supabase.auth.getUser()

    if (userError || !user?.email) return

    const email = user.email.trim().toLowerCase()
    const { data, error } = await supabase
      .from('login')
      .select('name, email')
      .ilike('email', email)
      .maybeSingle()

    if (error) throw error

    const firstName = getFirstName(data?.name)
    if (!firstName) return

    const applyName = () => {
      Object.entries(DISPLAY_TARGETS).forEach(([id, formatter]) => {
        const element = document.getElementById(id)
        const value = formatter(firstName)

        if (element && element.textContent !== value) {
          element.textContent = value
        }
      })
    }

    const observer = new MutationObserver(applyName)

    Object.keys(DISPLAY_TARGETS).forEach(id => {
      const element = document.getElementById(id)
      if (element) {
        observer.observe(element, {
          childList: true,
          characterData: true,
          subtree: true
        })
      }
    })

    applyName()
  } catch (error) {
    console.error('Unable to load the Home display name:', error)
  }
}

function getFirstName(value) {
  if (typeof value !== 'string') return ''
  return value.trim().split(/\s+/).filter(Boolean)[0] || ''
}
