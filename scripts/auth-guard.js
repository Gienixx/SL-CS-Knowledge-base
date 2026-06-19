import { supabase } from './supabaseClient.js'

async function requireAuthentication() {
    try {
        const {
            data: { session },
            error
        } = await supabase.auth.getSession()

        if (error) {
            console.error('Session check failed:', error)
        }

        if (!session?.user) {
            const returnTo =
                window.location.pathname +
                window.location.search +
                window.location.hash

            const loginUrl = new URL('./login.html', window.location.href)
            loginUrl.searchParams.set('returnTo', returnTo)

            window.location.replace(loginUrl.href)
            return
        }

        console.log('Authenticated user:', session.user.email)
    } catch (error) {
        console.error('Authentication guard failed:', error)
        window.location.replace('./login.html')
    }
}

requireAuthentication()
