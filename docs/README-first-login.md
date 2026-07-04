# Email invitation onboarding

Administrators manage invitations from `user-management.html`.

The current flow is:

1. `scripts/user-management.js` verifies that the signed-in user is an administrator.
2. It generates a strong temporary credential that is never displayed or shared.
3. The protected `/create-user` endpoint creates the approved Auth account and matching `login` row.
4. Supabase sends the new user a password-setup email that redirects to `change-password.html?invite=1`.
5. The first-login password flow records completion and redirects the user to the dashboard.
6. If sending the setup email fails, the new Auth account and `login` row are removed through `/delete-user`.

The production site URL, including `change-password.html`, must be included in Supabase Auth redirect URLs. The Supabase recovery email template may use invitation wording.
