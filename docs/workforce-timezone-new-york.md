# Workforce Timezone — America/New_York

The workforce, schedule, and attendance interfaces now use `America/New_York` as their default IANA timezone.

## Database deployment

Apply:

```text
supabase/migrations/2026070802_workforce_timezone_new_york.sql
```

Then run:

```text
supabase/verification/workforce_timezone_check.sql
```

The migration:

- changes the `profiles.timezone` and `work_schedules.timezone` defaults;
- updates existing records still set to `Asia/Manila`;
- preserves existing schedule wall-clock start and end times while changing their timezone;
- leaves historical attendance timestamps unchanged because they are actual recorded instants;
- normalizes legacy RPC fallback values to `America/New_York` through database triggers;
- continues accepting other explicitly configured valid IANA timezones.

After deployment, create or edit a test shift and confirm the schedule, attendance page, clock-in date, and clock-out date all follow Eastern Time, including daylight-saving changes.
