import { supabase } from './supabaseClient.js'

async function loadAuthenticatedPageEnhancements() {
    const currentPath = window.location.pathname.toLowerCase()

    if (currentPath.endsWith('/kb.html')) {
        await import('./kb-article-update-status.js?v=1')
    }

    if (currentPath.endsWith('/article.html')) {
        await import('./article-page-update-status.js?v=1')
    }
}

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

        await loadAuthenticatedPageEnhancements()
        console.log('Authenticated user:', session.user.email)
    } catch (error) {
        console.error('Authentication guard failed:', error)
        window.location.replace('./login.html')
    }
}

requireAuthentication()
