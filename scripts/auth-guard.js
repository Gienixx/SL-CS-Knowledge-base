import { supabase } from './supabaseClient.js'

function getCurrentRouteName() {
    const path = window.location.pathname
        .toLowerCase()
        .replace(/\/+$/, '')
    const lastSegment = path.split('/').pop() || ''

    return lastSegment.replace(/\.html$/, '')
}

async function loadAuthenticatedPageEnhancements() {
    const routeName = getCurrentRouteName()
    const modules = []

    if (routeName === 'kb') {
        modules.push(
            import('./kb-article-update-status.js?v=2')
        )
    }

    if (routeName === 'article') {
        modules.push(
            import('./article-page-update-status.js?v=2')
        )
    }

    const results = await Promise.allSettled(modules)

    for (const result of results) {
        if (result.status === 'rejected') {
            console.error(
                'Authenticated page enhancement failed:',
                result.reason
            )
        }
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
