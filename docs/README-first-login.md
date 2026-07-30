# Email invitation onboarding

Administrators manage invitations from Employee Profiles at `workforce.html`.

The current flow is:

1. `scripts/workforce.js` verifies canonical administrator access and the `manage_employees` permission.
2. The protected `/create-user` endpoint asks Supabase Auth to create the invited account. No temporary password is generated.
3. The endpoint transactionally provisions the matching workforce profile, `login` row, identity link, and permissions.
4. Supabase sends the new user an invitation email that redirects to `change-password.html?invite=1`.
5. The invite page requires the user to create and confirm their password.
6. The profile remains `invited` until the employee has authenticated through the invitation link and Supabase stores the password they chose.
7. A private database trigger then changes the workforce profile from `invited` to `active`.
8. The password flow records completion and redirects the user to the home page.
9. If workforce provisioning fails, the unified `/create-user` service rolls back the Auth account.

The production site URL, including `change-password.html`, must be included in Supabase Auth redirect URLs. The Supabase invite template should tell the recipient to accept the invitation and create their password. Resent invitations use the recovery template because the Auth account already exists.

## Reinviting a deleted employee

Deleted employees appear as **Archived** in Workforce Management. An authorized administrator can use **Reinvite employee** and confirm the employee's original email.

The restoration is intentionally staged:

1. Sending or resending the setup link creates a private pending restoration request. The employee profile remains archived.
2. When the recipient accepts the Supabase link, the new Auth account is linked to the original workforce profile and employee ID. Historical attendance, payroll, schedules, permissions, and audit records continue to belong to that same profile.
3. The restored profile appears as **Invited** while the recipient creates a password.
4. After the recipient creates their password, onboarding changes to **Active**.

Deleted email addresses remain absent from the active `profiles` and `login` identity tables. The controlled restoration registry stores only a SHA-256 email hash, not a plaintext former email.
