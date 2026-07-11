# Step 14 — Leave Management

Phase 1 leave management is implemented in `leave-requests.html` and
`scripts/leave-requests.js`.

## Agent workflow

- Submit vacation, sick, emergency, unpaid, or other leave with an inclusive
  date range and required reason.
- View the request history and reviewer outcome.
- Cancel an owned request while it is pending.

## Reviewer workflow

- Users with `approve_leave` can view requests within their authorized employee
  scope.
- Pending requests can be approved or rejected with optional review notes.
- The review RPC locks the request so concurrent reviewers cannot process it
  twice.
- Direct updates and deletes are revoked from browser roles; cancellation and
  review must use their audited RPC workflows.

## Approved leave and attendance

Approval marks each published or changed working shift inside the request range
as `on_leave`. The attendance record is also marked `approved` for review. Rest
days and holidays are excluded so they do not consume leave.

Approval fails transactionally when any attendance in the date range already has
clock activity or worked minutes. This prevents approved leave from overwriting
real attendance; an administrator must resolve the conflict first.

The leave request, attendance changes, reviewer identity, review time, and a
summary count are written to the workforce audit trail.

## Deployment

Step 14 is included in the active production schema baseline. Its original
implementation is preserved at
`supabase/migrations-legacy/2026071101_complete_leave_management.sql` and must
not be replayed against the linked project.

1. Run `supabase/verification/leave_management_check.sql` after deployment.
2. Test submission, cancellation, rejection, approval, team scope, rest-day
   exclusion, and an approval that overlaps clock activity.
