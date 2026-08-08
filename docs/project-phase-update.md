# SL CS Knowledge Base — Project Phase Update

**Status date:** August 8, 2026

**Repository:** `SL-CS-Knowledge-base`

**Current active work:** Revised Phase 2 payroll acceptance through two future linked controlled payroll periods

## Phase overview

| Phase | Scope | Status | Current position |
| --- | --- | --- | --- |
| Phase 1 | Workforce, Attendance, and Leave Foundation | Complete and released | All 18 steps passed the production-release gate on July 22, 2026 |
| Phase 2 | Rates, Payroll, and Payslips | In progress | Revised payroll workflow implemented; Step 14 controlled-period acceptance in progress; Step 15 not started |
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
- Kept Original Clock-in/Clock-out immutable as attendance evidence and added
  manager-adjustable Billed Clock-in/Billed Clock-out values.
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

Use manager-approved billed attendance and approved prepaid schedules to
calculate payroll, reconcile prepaid hours, preserve historical rates, and
provide private immutable payslips. Users do not submit separate payroll
timesheets.

### Approved payroll workflow

- Original Clock-in/Clock-out remain immutable attendance evidence. Managers
  may adjust Billed Clock-in/Billed Clock-out; every billed-time edit retains
  its audit history and reason.
- Managers review and approve attendance. Only approved attendance is
  payroll-ready, and approved Total Billed Hours are the payroll time source.
- No premium pay applies to overtime, holidays, rest days, special days, or
  excess hours. These remain classifications only; payable hours use the
  normal entered rate.
- Payroll managers may set or override the employee hourly rate in Draft
  payroll and may add audited reimbursements, incentives, bonuses, and other
  additions or deductions.
- Total Billed Hours is the complete payroll-hour basis: newly payable approved
  worked hours plus new prepaid hours paid in that cutoff. Previously paid
  prepaid hours being rendered only reduce the balance and are not paid again.
  Payroll estimate = Total Billed Hours × rate + additions − deductions.
- Existing prepaid-hour FIFO logic remains: approved billed hours consume
  previously paid prepaid hours first; only hours after the prepaid balance
  reaches zero become new regular payable hours. New prepaid schedules may be
  paid in advance and carried forward until rendered.
- Finalized payroll remains audited and locked under the existing workflow.

### Step 14 in progress — Revised controlled payroll acceptance

July historical testing is evidence-limited. Arby's manual payslip evidence is
the only available manual evidence, so the July findings are preserved but do
not support a full-population manual comparison:

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

The July findings remain part of the acceptance record:

- Resolve Arby Jann Benito's completed payslip comparison. The Jul 1–15
  system gross/net is USD 173.61 below the manual USD 860.01; the Jul 16–31
  system gross/net is USD 37.40 above the manual USD 737.00 after the approved
  July 29–30 workbook corrections were imported and recalculated. The payslip-only
  reimbursements and incentives have not been added to Draft payroll pending
  owner approval, and billed-hour/special-day differences remain unresolved.
- Keep the other eight payable employees marked `Manual evidence unavailable`
  for both July periods. Their missing values must not be inferred or entered
  as zero.
Historical missing evidence no longer prevents testing the revised workflow.
July remains evidence-limited historical validation because only Arby's manual
payslip evidence is available; missing values for the other employees are not
inferred and do not permanently block workflow validation. Step 14 will be
approved only after two future linked controlled payroll periods are actually
performed and validate billed hours, prepaid reconciliation, rate, additions
and deductions, payroll estimate, attendance approval, payroll finalization,
and payslip output, with signed payroll-owner approval. Those controlled
periods are not complete and must not be marked complete in advance.

### Step 15 not started — Phase 2 rollout and final acceptance

Step 15 follows the two controlled periods and covers final Phase 2 approval
and operational rollout. It must not be marked complete until the controlled
period evidence and approvals are actually recorded.

References:

- [Phase 2 implementation](payroll-phase-2-implementation.md)
- [Step 14 parallel payroll test](payroll-step-14-parallel-test.md)

## Recent changes — August 4–8, 2026

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
- The revised billed-attendance and payroll workflow was verified through the
  focused attendance/payroll suite and complete automated quality gate. The
  repository now reports 510 tests passing and 0 failing. The build produced
  206 production assets; build tests passed 1/1;
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

The repository was checked on August 8, 2026:

- The complete automated repository suite passed: **510 passed, 0 failed**.
- The build completed successfully with **206 production assets**.
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
- [ ] Perform and approve two future linked controlled payroll periods using
      manager-approved billed attendance as the payroll source
- [ ] Validate billed hours, prepaid reconciliation, rate, additions,
      deductions, payroll estimate, approval, finalization, and payslip output
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
