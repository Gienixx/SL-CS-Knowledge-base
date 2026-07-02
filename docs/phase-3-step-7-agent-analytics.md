# Phase 3 Step 7 — Expanded Agent Analytics

Step 7 combines the synchronized **Ticket Productivity** sheet with normalized Zendesk lifecycle events. It adds:

- solved-ticket and open-workload trends;
- average and median AHT;
- first-response and resolution time by mapped agent;
- reopen rate;
- team output share;
- workload share and a workload-adjusted performance index;
- team-level one-touch resolution context from the daily sheet.

SLA reporting is intentionally excluded. Do not enable the Zendesk SLA stream for this step.

## Apply

1. Run `supabase/migrations/2026070202_phase3_step7_agent_identity_map.sql` in the Supabase SQL Editor.
2. Run `supabase/migrations/2026070203_phase3_step7_agent_analytics_rpc.sql`.
3. Run `supabase/verification/phase3_step7_agent_analytics_check.sql`.
4. Review `public.agent_identity_map`. Exact unique name matches are mapped automatically.
5. For any row where `zendesk_agent_key` is null, set it to the correct key from `public.zendesk_agent_directory`.
6. Open `/agent-analytics.html` and compare several agents against the Ticket Productivity sheet and Zendesk.

## Metric interpretation

- **Average AHT** is solved-volume weighted when solved volume is available; otherwise it uses the simple average of daily AHT values.
- **Median AHT** is the median of the agent's daily AHT values in the selected range.
- **Reopen rate** is the share of resolved tickets that reopened after their selected-period resolution before the end of the range.
- **Workload-adjusted index** compares an agent's share of solved output with the agent's share of average open workload. `100` means the two shares are equal; values above `100` mean output share exceeds workload share.
- **One-touch resolution** remains team-level because the current productivity sheet does not provide agent-level one-touch counts.

## Keep disabled

Leave `ZENDESK_SLA_SYNC_ENABLED` unset and do not call `/api/sync-zendesk-sla`.
