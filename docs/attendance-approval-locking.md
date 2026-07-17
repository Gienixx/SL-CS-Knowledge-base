# Attendance approval and locking

Team Attendance uses `public.workforce_review_attendance(uuid, text, text)` for payroll review.

- An active administrator needs the explicit `approve_attendance` permission.
- Pending or corrected attendance can be approved only after required clock and calculation data is complete.
- Approved attendance can then be locked.
- Locked attendance cannot be updated, corrected, or deleted.
- Approval and locking store the reviewer and timestamp on attendance and append a before/after entry to `workforce_audit_logs`.
- Repeated approval or locking requests are idempotent and do not create duplicate audit events.

The browser never updates review fields directly. It calls the authorized RPC, reloads attendance, and shows the resulting review status.

Run `supabase/verification/attendance_approval_locking_check.sql` after deployment. Both boolean checks must return `true`, both blocker queries must return zero rows, and the rollout audit query must return one row.
