# Invitation onboarding

Administrators invite users from `admin.html`.

The active flow is:

1. `scripts/admin.js` sends the name, email, and permissions to `/create-user`.
2. `functions/create-user.js` verifies the administrator, inserts the allowlist row in `login`, and sends a Supabase Auth invitation.
3. Supabase redirects the accepted invitation to `change-password.html?invite=1`.
4. `scripts/change-password.js` lets the invited user create a password, marks onboarding complete in Auth metadata, and redirects to the dashboard.
5. `scripts/dashboard.js` verifies both the Auth session and the matching `login` row before granting access.

Configuration:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- Optional: `INVITE_REDIRECT_URL` for an explicit production callback URL.

The invitation callback URL must be allowed in Supabase Auth redirect settings.
