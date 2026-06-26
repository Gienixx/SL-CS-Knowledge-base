# Phase 2 Step 7 — Dashboard trigger migration

The production trigger lives in the Google Apps Script project bound to the dashboard workbook. Committing the helper to GitHub does not install the trigger automatically.

## Apps Script migration

1. Open the workbook's Apps Script project.
2. Add the contents of `apps-script/dashboard-trigger-migration.gs` to the project.
3. Confirm that `syncAllDashboardData` already exists in the same Apps Script project.
4. Select and run `migrateDashboardSyncTrigger` once.
5. Approve the requested trigger permissions.
6. Run `inspectDashboardSyncTriggers` and confirm:
   - `valid` is `true`.
   - `currentTriggerCount` is `1`.
   - `legacyTriggerCount` is `0`.
   - The remaining handler is `syncAllDashboardData`.
7. Open the Apps Script **Triggers** page and confirm the remaining dashboard trigger is time-driven, daily, and scheduled around 12 PM Eastern.

The migration deletes triggers for `syncDashboardData` and existing duplicate triggers for `syncAllDashboardData`. It does not delete unrelated project triggers or the legacy function itself.

## Immediate version 2 test

Run:

```text
testDashboardSyncV2Now
```

The returned endpoint response should contain:

```json
{
  "success": true,
  "payloadVersion": 2
}
```

A successful manual test confirms that `syncAllDashboardData` sends the version 2 multi-dataset payload. Step 7 is fully accepted after the next automatic trigger execution also succeeds.

## Supabase verification

No schema migration or data update is required for Step 7. Use this read-only query after the manual test and again after the next scheduled run:

```sql
select
  id,
  started_at,
  completed_at,
  status,
  report_date,
  rows_imported,
  sync_source,
  error_message
from public.sheet_sync_runs
where sync_source = 'apps_script'
order by started_at desc
limit 10;
```

Expected result for a successful run:

- `status = 'success'`
- `completed_at` is populated
- `rows_imported` is greater than zero when source data is present
- `error_message` is null
- `sync_source = 'apps_script'`

Also inspect the Apps Script execution log for `payloadVersion: 2`, because the current `sheet_sync_runs` table does not store the payload version.
