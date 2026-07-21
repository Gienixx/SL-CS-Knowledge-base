# Email invitation onboarding

Administrators manage invitations from Employee Profiles at `workforce.html`.

The current flow is:

1. `scripts/workforce.js` verifies canonical administrator access and the `manage_employees` permission.
2. The protected `/create-user` endpoint asks Supabase Auth to create the invited account. No temporary password is generated.
3. The endpoint transactionally provisions the matching workforce profile, `login` row, identity link, and permissions.
4. Supabase sends the new user an invitation email that redirects to `change-password.html?invite=1`.
5. The invite page requires the user to create and confirm their password.
6. When Supabase stores that first password, a database trigger changes the workforce profile from `invited` to `active`.
7. The password flow records completion and redirects the user to the home page.
8. If workforce provisioning fails, the unified `/create-user` service rolls back the Auth account.

The production site URL, including `change-password.html`, must be included in Supabase Auth redirect URLs. The Supabase invite template should tell the recipient to accept the invitation and create their password. Resent invitations use the recovery template because the Auth account already exists.
