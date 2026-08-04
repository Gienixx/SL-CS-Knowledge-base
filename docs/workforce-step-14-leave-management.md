# Leave Request Management

Leave requests use separate agent and administrator workflows in
`leave-requests.html` and `scripts/leave-requests.js`.

## Agent workflow

- Submit Incentive VL, Birthday VL, or Leave Without Pay for an inclusive date
  range with a required reason.
- View only owned requests and their current status.
- Read the administrator's decision reason when a request is denied.
- Cancel an owned request while it is pending.

## Administrator workflow

- Administrators with `approve_leave` see an approval page instead of the
  agent submission form.
- The Home sidebar displays a pending-request count for authorized approvers.
- Pending requests can be approved or denied. A denial reason is required and
  is displayed in the agent's history.
- Review history remains available after a request leaves the pending queue.
- The review RPC locks each pending request so two administrators cannot decide
  it concurrently.

## Approved leave and schedules

Approval converts eligible schedules in the request range to the selected leave
type and creates a leave schedule for any uncovered date. Every resulting row is
linked to its source through `work_schedules.leave_request_id`.

This does not create attendance history. Approval fails transactionally when
the date range already contains attendance or a completed schedule, so recorded
work is never silently replaced.

If schedule automation later creates another row in an approved leave range,
the database converts it to the linked leave type before it is saved.

## Security and verification

Browser roles cannot insert, update, or delete `leave_requests` directly.
Identity-safe submission, cancellation, and scoped review RPCs perform all
changes. Run `supabase/verification/leave_management_check.sql` after deployment
to verify privileges, denial reasons, and approved schedule linkage. The
rollback-only `supabase/verification/leave_management_transaction_check.sql`
exercises a complete approval and denial flow without retaining test records.
