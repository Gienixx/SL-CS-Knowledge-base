# Email invitation onboarding

Administrators manage invitations from Employee Profiles at `workforce.html`.

The current flow is:

1. `scripts/workforce.js` verifies canonical administrator access and the `manage_employees` permission.
2. It generates a strong temporary credential that is never displayed or shared.
3. The protected `/create-user` endpoint creates the approved Auth account and matching `login` row.
4. Supabase sends the new user a password-setup email that redirects to `change-password.html?invite=1`.
5. The first-login password flow records completion and redirects the user to the dashboard.
6. If sending the setup email fails, the unified `/create-user` service rolls back the Auth account and transactional workforce records.

The production site URL, including `change-password.html`, must be included in Supabase Auth redirect URLs. The Supabase recovery email template may use invitation wording.
