# SL CS Knowledge Base — Project Phase Update

**Status date:** August 3, 2026

**Repository:** `SL-CS-Knowledge-base`

**Current active work:** Phase 2, Step 14 — Two-Period Parallel Payroll Test

## Phase overview

| Phase | Scope | Status | Current position |
| --- | --- | --- | --- |
| Phase 1 | Workforce, Attendance, and Leave Foundation | Complete and released | All 18 steps passed the production-release gate on July 22, 2026 |
| Phase 2 | Rates, Payroll, and Payslips | In progress | Steps 1–13 complete; Step 14 in progress; Step 15 not started |
| Phase 3 | Reporting and Analytics | Complete in its current architecture | Reporting uses Google Sheet as its only active source; operational monitoring and secured exports are implemented |

## Phase 1 — Workforce, Attendance, and Leave Foundation

### Objective

Create the approved workforce and attendance source that payroll can safely
consume.

### Completed work

- Created the workforce database foundation for profiles, teams, permissions,
  schedules, attendance, leave requests, and audit logs.
- Linked active login identities to workforce profiles and assigned all 11
  active employees to the workforce roster.
- Implemented the supported Admin, Agent, Article Editor, supervisor, and
  permission-scoped access patterns.
- Built employee, team, schedule, rest-day, holiday, published-shift, and
  changed-shift administration.
- Built My Schedule and the agent Attendance interface.
- Added clock-in at any eligible time before a released shift, with automatic
  pre-shift, regular-time, and post-shift classification.
- Added trusted PostgreSQL attendance calculations for regular time, overtime,
  total worked time, lateness, and undertime.
- Added overnight-shift and multiple-shift support, one-open-session
  enforcement, invalid-duration protection, and the aggregated 20-hour
  overtime limit per employee and work date.
- Added structured attendance storage, immutable original timestamps, review
  statuses, and payroll-readiness blockers.
- Built Team Attendance with permission and supervisor scope, filters,
  correction controls, approval, and locking.
- Added structured, audited attendance corrections with mandatory reasons and
  preserved correction history.
- Completed the agent and administrator leave-request workflow and approved
  leave synchronization with attendance.
- Completed permission-matrix testing, the internal test deployment, the
  rollback-only full attendance cycle, and the production-release checks.

### Release result

Phase 1 was accepted for production on July 22, 2026. The recorded release
gate reported 11 active employees, complete identity coverage, no invalid
structured totals, no payroll-readiness mismatches, and no July 1–15
payroll-readiness blockers.

Reference: [Phase 1 production release](workforce-step-18-production-release.md)

## Phase 2 — Rates, Payroll, and Payslips

### Objective

Use approved Phase 1 attendance and approved prepaid schedules to calculate
payroll, reconcile prepaid hours, preserve historical rates, and provide
private immutable payslips.

### Steps 1–13 completed

1. Created the secured payroll and prepaid-hour reconciliation tables.
2. Added granular payroll permissions independent of general administrator
   access.
3. Assigned payroll access and own-payslip permissions with audited changes.
4. Implemented effective-dated USD rates without overwriting rate history.
5. Built payroll-period and prepaid-schedule management.
6. Added immutable attendance and approved-schedule imports.
7. Implemented atomic draft-payroll calculation and FIFO prepaid-hour
   reconciliation.
8. Built payroll exception review and prepaid reconciliation visibility.
9. Added audited manual earnings and deductions for editable payroll drafts.
10. Implemented review, approval, finalization, immutable locks, and controlled
    reopening.
11. Built the secured finalized-payslip preview.
12. Added server-rendered A4 PDFs, private storage, immutable PDF versions, and
    short-lived signed downloads.
13. Built My Payslips so employees can access only their own finalized
    payslips.

### Step 14 in progress — Parallel payroll test

The July 1–15 system payroll is ready for manual comparison:

- 9 payable employee payroll records remain after both testing-only profiles
  were excluded. The separate `Test` profile's prior zero-pay record is void
  and preserved for audit history.
- No blocking exceptions for the period.
- USD 7,466.06 system gross pay and net pay.
- 25,800 prepaid minutes added and fully applied.
- Rollback-only exact-match, partial-work, multi-day settlement,
  overtime-settlement, and special-day-exclusion scenarios passed.
- Production payroll remains in Draft and has not been finalized merely for
  testing.

The approved `2026 Support Timesheet.xlsx` workbook was restored on August 3.
Its Almar rows confirm that July 27–29 match the system source times. The latest
July 30 and July 31 source times are 10:15 AM–4:15 AM and 9:00 AM–3:00 AM,
respectively. Those two system schedules still contain the older 6:00 AM–
12:00 AM times, so the system correction remains outstanding; applying the
July 30 source time will remove the current July 29/30 overlap.

All four shifts that were open at the July 30 checkpoint now have clock-outs.
There are no open July shifts. Eleven payable July 30–31 attendance records
still require review and approval before the second period can be calculated.

The following work is still required before Step 14 can be approved:

- Correct Almar's July 30 and July 31 system schedule times from the restored
  approved workbook, removing the July 29/30 overlap.
- Review and approve the 11 remaining payable July 30–31 attendance records.
- Compare manual and system values employee by employee for both payroll
  periods.
- Resolve every variance and capture the payroll owner's signed and dated
  approval.

### Step 15 not started — Controlled payroll periods

Step 15 will run two linked controlled payroll periods with complete manual
verification. It must not begin until Step 14 is fully reconciled and approved.

References:

- [Phase 2 implementation](payroll-phase-2-implementation.md)
- [Step 14 parallel payroll test](payroll-step-14-parallel-test.md)

## Phase 3 — Reporting and Analytics

### Objective

Provide synchronized operational reporting, detailed dashboards, agent
analytics, data-quality monitoring, and administrator reporting operations.

### Current completed architecture

- Google Sheet is the only active reporting source.
- The protected dashboard synchronization endpoint validates, maps, and stores
  workbook reporting data in Supabase.
- The active workbook flow uses Daily Volume, Ticket Productivity, and Daily
  Drivers.
- Dashboard overview, detailed trends, agent analytics, supported response
  metrics, and reporting operations pages are available.
- Reporting Operations is restricted to active administrators with the
  explicit workforce-report permission.
- Synchronization status, freshness, row counts, data-quality checks, alerts,
  audit history, and authenticated CSV exports are implemented.
- Automated Manila-time synchronizations are configured for approximately
  9:00 PM and 12:00 AM.
- Unsupported metrics are not reconstructed or presented as real data.
- Earlier Zendesk synchronization work was retired during the Google
  Sheet-only cutover; no active browser module or synchronization endpoint
  reads Zendesk.
- Phase 3 verification artifacts cover the Google Sheet contract, sheet-only
  reporting, dashboard features, reporting operations, and final acceptance.

Reference: [Reporting system](reporting-system.md)

## Repository verification

The repository was checked on August 3, 2026:

- `main` matched `origin/main` before this status file was added.
- The working tree was clean before this status file was added.
- The complete automated repository suite passed: **459 passed, 0 failed**.

## Completion checklist

### Phase 1

- [x] Workforce database and employee roster completed
- [x] Roles, permissions, identity links, and supervisor scope completed
- [x] Workforce and schedule administration completed
- [x] Agent schedule and attendance interface completed
- [x] Revised early clock-in and overtime rules completed
- [x] Structured server-side attendance calculations completed
- [x] Team Attendance completed
- [x] Attendance corrections, history, approval, and locking completed
- [x] Leave management completed
- [x] Payroll-readiness rules completed
- [x] Internal deployment and full attendance-cycle testing completed
- [x] Phase 1 production release completed

### Phase 2

- [x] Payroll tables and permissions completed
- [x] Effective-dated agent rates completed
- [x] Payroll-period and prepaid-schedule management completed
- [x] Immutable attendance and schedule imports completed
- [x] Draft payroll and FIFO prepaid reconciliation completed
- [x] Exception review completed
- [x] Audited draft adjustments completed
- [x] Payroll approval, finalization, and locking completed
- [x] Payslip preview completed
- [x] Private PDF generation and storage completed
- [x] Agent My Payslips access completed
- [x] July 1–15 system calculation prepared for comparison
- [x] Rollback-only prepaid reconciliation scenarios passed
- [x] Restore the approved manual payroll workbook
- [x] Close the four shifts that were open at the July 30 checkpoint
- [x] Exclude both testing-only profiles from payroll
- [ ] Correct Almar's July 30–31 system schedule times
- [ ] Review and approve the 11 payable July 30–31 attendance records
- [ ] Complete and approve the two-period manual comparison
- [ ] Run two linked controlled payroll periods
- [ ] Approve Phase 2 as the primary payroll process

### Phase 3

- [x] Google Sheet reporting contract completed
- [x] Protected reporting synchronization completed
- [x] Sheet-only reporting schema and services completed
- [x] Dashboard and detailed reporting pages completed
- [x] Agent analytics completed
- [x] Reporting Operations access controls completed
- [x] Synchronization monitoring, quality checks, alerts, and history completed
- [x] Authenticated reporting exports completed
- [x] Zendesk reporting path retired from the active architecture
- [x] Phase 3 reporting verification and acceptance artifacts completed
