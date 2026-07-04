# Database maintenance

## Migration naming

Files in `supabase/migrations/` use:

`<version>_<descriptive_name>.sql`

The numeric prefix is the migration version and must remain stable after a migration has been applied. The repository cleanup removed temporary phase and step labels from the descriptive suffix while preserving every existing version prefix and SQL body.

Renaming only the suffix does not require rerunning an already-applied migration. Do not modify an applied version's SQL merely to change comments or naming.

## Verification naming

Files in `supabase/verification/` are read-only checks named for the capability they validate, such as:

- `dashboard_sync_integrity_check.sql`
- `google_sheet_contract_check.sql`
- `sheet_only_reporting_check.sql`
- `reporting_acceptance_check.sql`
- `sync_history_visibility_check.sql`

Verification files are not migrations and may be run whenever operational confirmation is needed.

## Applying a new migration

1. Confirm the version prefix is newer than existing migrations.
2. Review the SQL in a branch and pull request.
3. Apply it through the approved Supabase workflow.
4. Run the relevant verification checks.
5. Confirm the deployed site and Reporting Operations page.

## Historical database objects

Some older database tables or functions may remain because deleting applied schema objects requires an explicit, reviewed decommission migration. Repository cleanup does not silently drop production database objects.
