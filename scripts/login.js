import { supabase } from './supabaseClient.js'

const loginForm = document.getElementById('loginForm')
const loginStatus = document.getElementById('loginStatus')

function getReturnPage() {
    const params = new URLSearchParams(window.location.search)
    const returnTo = params.get('returnTo')

    if (
        returnTo &&
        returnTo.startsWith('/') &&
        !returnTo.startsWith('//')
    ) {
        return returnTo
    }

    return './dashboard.html'
}

const returnPage = getReturnPage()

const {
    data: { session }
} = await supabase.auth.getSession()

if (session?.user) {
    window.location.replace(returnPage)
} else {
    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault()

        const email = document.getElementById('email').value.trim()
        const password = document.getElementById('password').value

        loginStatus.textContent = 'Signing in...'
        loginStatus.className = 'status'

        const { error } = await supabase.auth.signInWithPassword({
            email,
            password
        })

        if (error) {
            loginStatus.textContent = error.message
            loginStatus.className = 'status error'
            return
        }

        loginStatus.textContent = 'Login successful. Redirecting...'
        loginStatus.className = 'status success'

        window.location.replace(returnPage)
    })
}
