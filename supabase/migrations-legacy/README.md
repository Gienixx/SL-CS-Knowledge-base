# Legacy migration archive

These files preserve the database's pre-baseline implementation history. They
are intentionally outside `supabase/migrations` because several files shared
the same migration version and the live database had no matching migration
history.

Do not run these files against the linked project and do not move them back into
the active migration directory. The current live schema is represented by the
baseline in `supabase/migrations`.

Static repository tests may read these files to verify how individual features
were introduced. New database changes must be created with:

```powershell
npx --yes supabase@latest migration new descriptive_name
```
