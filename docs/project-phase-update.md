# SL CS Knowledge Base — Project Phase Update

**Status date:** August 6, 2026

**Repository:** `SL-CS-Knowledge-base`

**Current active work:** Payroll acceptance for Phase 2, Step 14 — Two-Period Parallel Payroll Test

## Phase overview

| Phase | Scope | Status | Current position |
| --- | --- | --- | --- |
| Phase 1 | Workforce, Attendance, and Leave Foundation | Complete and released | All 18 steps passed the production-release gate on July 22, 2026 |
| Phase 2 | Rates, Payroll, and Payslips | In progress | Steps 1–13 complete; Step 14 blocked pending payroll acceptance; Step 15 not started |
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

### Step 14 blocked — Parallel payroll test and acceptance

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

The July 16–31 payroll was calculated in production on August 3 after the
approved `2026 Support Timesheet.xlsx` values were revalidated. All 115 current
attendance snapshots are imported, all 9 payable records are ready for review,
and the period has zero blocking exceptions. Both testing-only profiles remain
payroll-ineligible and have no active record. The system result is USD 7,805.90
gross and net, with USD 0.00 deductions, 36,300 prepaid minutes added, 22,176
applied, and 14,124 carried forward.

Almar's current July 28–31 schedule versions are now the approved prepaid
sources using the exact workbook LOG IN / LOG OUT windows. Their four stale
version-2 balances are void and linked to the replacements. All four shifts
that were open at the July 30 checkpoint have clock-outs, and no July shift or
attendance review remains open.

The following work is still required before Step 14 can be approved:

- Resolve Arby Jann Benito's completed payslip comparison. The Jul 1–15
  system gross/net is USD 173.61 below the manual USD 860.01; the Jul 16–31
  system gross/net is USD 37.40 above the manual USD 737.00 after the approved
  July 29–30 workbook corrections were imported and recalculated. The payslip-only
  reimbursements and incentives have not been added to Draft payroll pending
  owner approval, and billed-hour/special-day differences remain unresolved.
- Keep the other eight payable employees marked `Manual evidence unavailable`
  for both July periods. Their missing values must not be inferred or entered
  as zero.
- Run a later full-population, two-period comparison because the approved
  partial July evidence scope cannot meet the existing Step 14 completion
  gate.
- Capture the remaining rate-change and post-finalization-correction scenario
  evidence.
- Resolve every variance and capture the payroll owner's signed and dated
  approval.

Core payroll development for the current scope is complete. The remaining
work is payroll acceptance: documented manual evidence, variance resolution,
and payroll-owner approval. Missing evidence remains a blocker and is not
treated as zero.

### Step 15 not started — Controlled payroll periods

Step 15 will run two linked controlled payroll periods with complete manual
verification. It must not begin until Step 14 is fully reconciled and approved.

References:

- [Phase 2 implementation](payroll-phase-2-implementation.md)
- [Step 14 parallel payroll test](payroll-step-14-parallel-test.md)

## Recent changes — August 4–5, 2026

- Resolved the My Schedule automated test failures. Schedule drafts remain
  visible to authorized schedule managers through the canonical controller;
  personal scope uses resolved workforce identities; and team scope remains
  limited to `manage_schedules` plus RLS-visible profiles.
- Resolved stale Team Attendance test expectations for the accepted compact
  card layout, five-record pagination, filtered billed-hours summary, and
  fully classified overtime handling. The current Team Attendance script and
  stylesheet references use `v=13`.
- Removed the unused duplicate Attendance theme toggle and its obsolete light
  theme CSS; Home remains the primary theme control. Correction visibility
  continues to use `redactAttendanceCorrectionForViewer` without permission
  changes.
- The complete automated quality gate now reports 489 tests passing and 0
  failing. The build produced 200 production assets; build tests passed 1/1;
  repository checks passed 11/11.

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

The repository was checked on August 6, 2026:

- The complete automated repository suite passed: **489 passed, 0 failed**.
- The build completed successfully with **200 production assets**.
- Build tests passed: **1 passed, 0 failed**.
- Repository checks passed: **11 passed, 0 failed**.

The August 3 result of **459 out of 459 tests** is historical and is retained
here for comparison only. The newer repository baseline was **489 tests, 479
passing, and 10 failing** before the targeted corrections; it is no longer
the current result.

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
- [x] Correct Almar's July 30–31 system schedule times
- [x] Approve Almar's current July 28–31 prepaid schedule versions
- [x] Review and approve the remaining payable July attendance records
- [x] Calculate the July 16–31 draft payroll for all 9 payable employees
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
