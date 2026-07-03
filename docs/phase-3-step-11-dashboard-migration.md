# Phase 3 Step 11: migrate all dashboards to synchronized Google Sheet reporting

## Goal

Complete the reporting UI migration after Step 10. The overview dashboard, detailed reports, Expanded Agent Analytics, and Response Times now use synchronized Google Sheet tables only.

No active dashboard reads Zendesk events, agent mappings, directory records, or ticket-dimension profiles.

## Reporting pages

- `dashboard.html`: the existing daily overview, with direct navigation to Agent Analytics and Response Times.
- `report-details.html`: team-level report trends, previous-period comparisons, absolute and percentage change, optional targets, and drill-down links.
- `agent-analytics.html`: solved output, open workload, AHT, team share, workload-adjusted ranking, comparisons, and synchronized dimension drill-downs.
- `response-times.html`: first-response and resolution metrics only when the corresponding Daily Volume counts and totals are populated.

Every reporting page labels its source as **Synchronized Google Sheet**.

## Filters and cross-filter boundary

Date range is always available when a source table has reporting dates.

Agent, app, platform, country, concern, priority, and channel options are populated only from synchronized data. Cross-filtered agent views use `agent_dimension_metrics`.

The current contract stores aggregate counts per agent and dimension. Therefore:

- one dimension can be selected at a time;
- selected-dimension views report matched ticket counts and shares;
- solved tickets, open workload, AHT, response time, resolution time, and reopen metrics are not inferred for a dimension selection;
- filters with no synchronized `agent_dimension_metrics` rows remain unavailable.

## Period and target comparisons

Each detailed report compares the selected range with the immediately preceding range of equal length. The UI shows:

- current value;
- previous-period value;
- absolute change;
- percentage change.

`dashboard_targets` is optional. Add an active row only for a metric with an approved business target. No default targets are inserted.

Common metric keys include:

- `new_tickets`
- `solved_tickets`
- `unsolved_tickets`
- `one_touch_resolution`
- `reopened_rate`
- `agent_solved_tickets`
- `response_time_minutes`
- `resolution_time_minutes`
- `<dimension>_ticket_count`, such as `app_ticket_count`

## Missing metrics

The UI treats a metric as unavailable when its supporting synchronized count or field is absent. A zero default in an unused schema column is not presented as a measured response-time or resolution-time result.

## Apply Step 11

1. Run this migration in the Supabase SQL Editor:

   `supabase/migrations/2026070401_phase3_step11_dashboard_features.sql`

2. Deploy the merged website build.
3. Run the read-only verification:

   `supabase/verification/phase3_step11_dashboard_check.sql`

4. Open and verify:

   - `/dashboard.html`
   - `/report-details.html?report=new-vs-solved&range=30d`
   - `/agent-analytics.html?range=30d`
   - `/response-times.html?range=30d`

5. Confirm unavailable filters and metrics are clearly labeled rather than reconstructed.

No new Google Sheet tabs, Zendesk synchronization, or Zendesk field mapping are required by Step 11.
