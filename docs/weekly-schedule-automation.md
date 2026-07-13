# Weekly schedule automation

The initial rollout assigns one weekly template only to `arby@eurekasurveys.com`.
The assignment schema supports team templates later, but no team assignment is
created by this migration.

## Test schedule

- Sunday: rest day
- Monday: rest day
- Tuesday through Friday: 10:00 AM–6:00 PM
- Saturday: 6:00 AM–2:00 PM
- Timezone: `America/New_York`

The cron job checks hourly on Sundays and generates only during the 6:00 AM New
York hour. This avoids daylight-saving drift while keeping the database timezone
in UTC. Generated schedules are published immediately.

Generation uses the existing `(user_id, shift_date, shift_sequence)` uniqueness
rule and inserts missing rows only. Existing rows and admin edits are never
overwritten. Admin changes to an automated row mark it as an override.

Approved leave cancels generated working shifts. Rest days are retained. If the
leave approval is withdrawn, only automatically cancelled, non-overridden rows
are restored to published. Holidays are not added or substituted automatically.

## Verification

After applying the migration, run:

```text
supabase/verification/weekly_schedule_automation_check.sql
```

Confirm that the template has seven entries, the assignment is user-only, the
cron job is active, and a second generator call inserts zero rows.
