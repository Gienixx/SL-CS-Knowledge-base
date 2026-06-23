# Email invitation onboarding

Administrators can open `invite-user.html` from the dashboard.

The current test flow is:

1. `scripts/invite-user.js` verifies that the signed-in user is an administrator.
2. It generates a strong temporary credential that is never displayed or shared.
3. The existing protected `/create-user` endpoint creates the approved Auth account and matching `login` row.
4. Supabase sends the new user a password-setup email that redirects to `change-password.html?invite=1`.
5. The existing first-login password flow records completion and redirects the user to the dashboard.
6. If sending the setup email returns an error, the new Auth account and `login` row are removed through `/delete-user`.

The production site URL, including `change-password.html`, must be included in Supabase Auth redirect URLs.

The default Supabase recovery email template can be customized to use invitation wording.
