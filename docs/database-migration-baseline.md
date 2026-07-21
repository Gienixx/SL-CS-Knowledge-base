# Database migration baseline

The active Supabase migration history was rebased on 2026-07-11 because the
linked production database contained the application schema while its migration
history table was empty. The old directory also contained duplicate migration
versions, so bulk history repair could not reliably represent individual files.

## Active history

`supabase/migrations/20260711083340_remote_schema_baseline.sql` is a schema-only
snapshot pulled from the linked production project's `public` schema after the
Phase 1 Step 14 leave workflow was deployed and verified.

The baseline contains no table data and no plaintext application credentials.
Operational production data remains in the remote database. Pre-repair schema,
role, and public-data backups were created outside the repository before the
history repair.

## Historical files

Earlier migrations are preserved in `supabase/migrations-legacy`. They document
the implementation sequence and support static tests, but they are not active
deployments and must not be replayed against the linked project.

## Standard workflow

Create every new change with a unique CLI-generated timestamp:

```powershell
npx --yes supabase@latest migration new descriptive_name
```

Test locally, review the SQL, and deploy with:

```powershell
npx --yes supabase@latest db push --dry-run
npx --yes supabase@latest db push
```

Never apply schema changes directly in the dashboard unless a documented
incident requires it. If that happens, capture the change in a migration and
repair history immediately.

## History reconciliation

On 2026-07-21, repository migration filenames were aligned to the exact versions
already recorded by the linked production project. The missing
`20260716062407_attendance_payroll_readiness.sql` migration was recovered from
Supabase's stored migration statements. The committed
`20260715144740_canonical_article_authorization.sql` migration was verified
against all 11 linked identities, applied, and recorded in migration history.

Before deploying another database change, run:

```powershell
npx --yes supabase@latest migration list --linked
```

Every row must contain the same local and remote version. A blank side is a
release blocker and must be reconciled before `db push`.
