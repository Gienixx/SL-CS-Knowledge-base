# Phase 2 Step 14 — Two-Period Parallel Payroll Test

## Purpose

Compare the existing approved manual payroll process with the new payroll
system for two consecutive periods before the system becomes the primary
payroll process.

The comparison must be employee by employee. Aggregate totals alone are not
enough to approve Step 14.

## Comparison fields

For each employee and payroll period, record:

- Regular minutes
- Overtime minutes
- Guaranteed special-day pay
- Prepaid minutes added
- Prepaid minutes settled
- Opening prepaid-minute balance
- Closing prepaid-minute balance
- Excess minutes payable in the later period
- Gross pay
- Manual deductions
- Net pay

The manual source value, system value, and variance must remain visible beside
each other. Minute variances must be zero. Money variances may differ by no
more than USD 0.01 only when the difference is explained by the documented
half-up cent rounding rule.

## Required scenario evidence

The two-period test must prove:

1. Prepaid hours exactly matched by actual work.
2. Prepaid hours partially rendered, leaving an open balance.
3. One prepaid balance settled across multiple later workdays.
4. Ordinary pre-shift or post-shift overtime used after regular minutes to
   settle a prepaid balance.
5. Actual ordinary minutes exceeding all open prepaid balances and becoming
   payable in the later period.
6. Rest-day and holiday work remaining additional pay instead of settling a
   prepaid balance.
7. A rate change between a prepaid source work date and later attendance,
   proving each newly payable minute uses the rate effective on its actual work
   date.
8. An attendance correction after finalization, proving the finalized payroll
   remains unchanged and the difference is handled through a future
   adjustment or controlled reopening.

## Execution controls

- Use only the approved manual payroll workbook or signed manual payroll
  report as the comparison source.
- Do not infer or manufacture missing manual totals.
- Keep production payroll in Draft while building the comparison.
- Resolve every blocking exception before calculating the affected period.
- Recalculate immediately before capturing system totals.
- Do not finalize production payroll merely to complete the parallel test.
- Record the manual source filename, sheet, row, preparation date, reviewer,
  and approval date.
- Explain every non-zero variance and correct the source data, system rule, or
  calculation before approval.

## Run started July 30, 2026

### Period 1 — July 1–15

- Status: system calculation ready for manual comparison.
- Payable employees retained: 9. The testing-only `Test` profile's calculated
  zero-pay record was voided on August 3 and retained for audit history.
- Calculated payable records: 9.
- Blocking exceptions: 0.
- System gross pay: USD 7,466.06.
- System deductions: USD 0.00.
- System net pay: USD 7,466.06.
- Prepaid minutes added: 25,800.
- Prepaid minutes applied: 25,800.
- Production status remains Draft.

### Period 2 — July 16–31

- Status: calculated and ready for manual comparison.
- Employees loaded: 9 payroll records after the payroll owner excluded both
  the `test test` and separate `Test` testing-only profiles. The separate
  `Test` profile's untouched draft shell was removed on August 3.
- Calculated records: 9, all `ready_for_review` with no recalculation flag.
- Payment date: July 27, corrected from July 31 after owner confirmation. The
  four-day early payment uses the required documented override because the
  standard window is three days.
- Attendance approval: all 115 payroll-ready attendance records are approved,
  imported at their current versions, and represented by immutable snapshots.
- Open July shifts: 0. The four shifts that were open at the July 30 checkpoint
  now have clock-outs. They belonged to Arby Jann Benito, Genevive Serrano,
  Leufard Vallega, and Jean Vestil.
- Attendance review blockers: 0. Missing attendance, missing clock-out,
  incomplete attendance, pending review, and missing-rate counts are all 0 in
  the authoritative readiness view.
- Almar's July 27–31 schedules were corrected from the payroll owner's source
  times. July 27 now exactly matches the corrected 6:00 AM–12:00 AM
  attendance. The current July 28–31 schedule versions are approved prepaid
  entries using 11:30 AM–5:30 AM, 2:00 PM–8:00 AM, 10:15 AM–4:15 AM, and
  9:00 AM–3:00 AM, respectively. Their four stale version-2 balances are void
  and linked to the replacement balances.
- Restored manual source: `2026 Support Timesheet.xlsx` is available again at
  its Downloads path as of August 3. Its SHA-256 is
  `949d4e4547f92829a3a631e8d7b4712e45fedeac8a1ad14245cdcd231b47d590`.
- Missing-rate exceptions: 0 after excluding the testing-only profile.
- System gross pay: USD 7,824.41.
- System deductions: USD 0.00.
- System net pay: USD 7,824.41.
- Prepaid minutes added: 36,300.
- Prepaid minutes applied: 22,172.
- Closing prepaid-minute balance: 14,128.
- Blocking exceptions: 0.
- Valid carry-forward warnings: 19 unresolved prepaid balances. These warnings
  are non-blocking because they represent positive minutes to render later.
- Production status remains Draft.

#### Period 2 system comparison baseline

Opening prepaid minutes are 0 for every employee. The table is the system side
of the required comparison captured immediately after calculation on August 3,
2026. `Special min` combines rest-day and holiday minutes. `Excess ordinary`
is ordinary regular plus overtime minutes remaining payable after FIFO prepaid
settlement.

| Employee | Regular min | OT min | Special min | Prepaid added | Prepaid applied | Closing prepaid | Excess ordinary | Special-day pay | Gross USD | Deductions USD | Net USD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Alen Tristan Adeva | 3,120 | 3,780 | 480 | 3,840 | 965 | 2,875 | 5,935 | 25.60 | 598.40 | 0.00 | 598.40 |
| Almar Contreras | 5,400 | 3,244 | 4,320 | 4,320 | 4,320 | 0 | 4,324 | 560.00 | 1,640.33 | 0.00 | 1,640.33 |
| Amora Angeles | 3,360 | 4,200 | 4,440 | 4,920 | 1,087 | 3,833 | 6,473 | 371.20 | 1,036.80 | 0.00 | 1,036.80 |
| Arby Jann Benito | 3,840 | 4,367 | 1,620 | 4,320 | 3,236 | 1,084 | 4,971 | 124.80 | 792.91 | 0.00 | 792.91 |
| Arez Santos | 4,050 | 5,670 | 1,890 | 2,760 | 720 | 2,040 | 9,000 | 164.50 | 892.50 | 0.00 | 892.50 |
| Genevive Serrano | 4,200 | 5,292 | 960 | 3,420 | 3,304 | 116 | 6,188 | 56.00 | 809.19 | 0.00 | 809.19 |
| Jean Vestil | 2,510 | 1,578 | 1,368 | 3,720 | 3,358 | 362 | 730 | 89.92 | 506.35 | 0.00 | 506.35 |
| Jerson Gavileño | 3,360 | 3,210 | 1,800 | 4,800 | 982 | 3,818 | 5,588 | 167.20 | 887.30 | 0.00 | 887.30 |
| Leufard Vallega | 2,869 | 2,222 | 660 | 4,200 | 4,200 | 0 | 891 | 72.20 | 660.63 | 0.00 | 660.63 |
| **Total** | **32,709** | **33,563** | **17,538** | **36,300** | **22,172** | **14,128** | **44,100** | **1,631.42** | **7,824.41** | **0.00** | **7,824.41** |

The supplied support timesheet contains the source schedule and login/logout
activity but no signed manual gross-pay, deduction, or net-pay totals. Manual
values and variances must therefore remain pending until the approved manual
payroll report is provided; they must not be inferred from the activity log.

### Testing-only payroll exclusion

- `test test` remains an active workforce account for non-payroll testing.
- A separate payroll-eligibility control now prevents the profile from being
  loaded into future payroll periods.
- Its untouched July 16–31 draft payroll shell was removed.
- The exclusion reason and removed draft record ID were written to the payroll
  audit history.
- New payroll records are database-blocked for excluded profiles, including
  records attempted outside the normal period-creation screen.
- The separate `Test` profile was also confirmed as testing-only on August 3
  and is now payroll-ineligible. Its untouched July 16–31 draft shell was
  removed, while its July 1–15 zero-pay calculation was voided and preserved
  for audit history. Neither testing-only profile has an active payroll record.

### Rollback-only scenario test

The connected production database passed the existing rollback-only integration
suite on July 30, 2026:

- Exact match: 480 of 480 minutes settled.
- Partial work: 300 minutes settled and 180 minutes carried forward.
- Multi-day carry-forward: 180, 180, and 120 minutes settled over three days.
- Overtime settlement: 480 regular, 60 pre-shift overtime, and 60 post-shift
  overtime minutes settled a 600-minute balance.
- Special-day exclusion: two rest-day/holiday snapshots settled zero ordinary
  prepaid minutes, leaving the full 480-minute balance open.
- Persistent synthetic attendance after rollback: 0.
- Persistent synthetic schedule snapshots after rollback: 0.

The end-to-end rate-change and post-finalization correction scenarios still
need to be evidenced in the two-period comparison.

## Current blockers

1. Obtain the signed manual payroll report containing employee-level manual
   minutes, deductions, gross pay, and net pay for both July periods. The
   support timesheet alone does not contain these approved payroll totals.
2. Enter the approved manual values beside the captured system baseline and
   resolve every employee and period variance.
3. Capture the remaining rate-change and post-finalization-correction scenario
   evidence and obtain the payroll owner's signed, dated approval.

## Completion evidence

Step 14 is complete only when:

- Both periods contain approved manual and system values for every included
  employee.
- Every required scenario has a traceable source row and system evidence.
- Every minute variance is zero.
- Every money variance is zero or an approved USD 0.01 rounding difference.
- The employee and period totals reconcile to the approved manual payroll.
- All discrepancies and corrections are documented.
- The payroll owner signs and dates the comparison.
