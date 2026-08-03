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

- Status: not ready for calculation.
- Employees loaded: 9 payroll records after the payroll owner excluded both
  the `test test` and separate `Test` testing-only profiles. The separate
  `Test` profile's untouched draft shell was removed on August 3.
- Calculated records: 0.
- Payment date: July 27, corrected from July 31 after owner confirmation. The
  four-day early payment uses the required documented override because the
  standard window is three days.
- Attendance approval: 99 completed review-required records were approved on
  July 30 with one prior approved record, leaving 100 approved records.
- Open July shifts: 0. The four shifts that were open at the July 30 checkpoint
  now have clock-outs. They belonged to Arby Jann Benito, Genevive Serrano,
  Leufard Vallega, and Jean Vestil.
- Attendance review: 12 payable July 30–31 records remain pending approval:
  Alen Tristan Adeva, Almar Contreras, Arby Jann Benito, Genevive Serrano,
  Jean Vestil, and Leufard Vallega for July 30; and Almar Contreras, Amora
  Angeles, Genevive Serrano, Jean Vestil, Jerson Gavileño, and Leufard Vallega
  for July 31.
- Missing attendance entries: 0 after Almar's July 28–31 schedules were
  approved as prepaid schedule snapshots.
- Almar's July 27–31 schedules were corrected from the payroll owner's source
  times. July 27 now exactly matches the corrected 6:00 AM–12:00 AM
  attendance. The exact July 28–31 schedule versions are now approved prepaid
  entries and created four 1,080-minute carry-forward balances.
- Restored manual source: `2026 Support Timesheet.xlsx` is available again at
  its Downloads path as of August 3.
- Almar source validation: July 27–29 match the system. On August 3, July 30
  was corrected to 10:15 AM–4:15 AM and July 31 to 9:00 AM–3:00 AM from the
  workbook's LOG IN / LOG OUT columns. Both schedules advanced from version 2
  to version 3, their attendance punches were preserved and recalculated, and
  the July 29/30 overlap is removed with a 135-minute gap. The prior version-2
  prepaid balances remain unsettled and can be safely superseded when the
  corrected versions are approved.
- Missing-rate exceptions: 0 after excluding the testing-only profile.
- Valid carry-forward warnings: 37 unresolved prepaid balances, including
  Almar's four newly approved balances. These warnings are non-blocking when
  the balances are valid.
- Production status remains Draft.

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

1. Approve Almar's corrected July 30 and July 31 version-3 schedules as the
   current prepaid sources; their version-2 balances are unsettled.
2. Review and approve the 12 payable July 30–31 attendance records. No July
   shift remains open; these are review blockers rather than missing
   clock-outs.
3. Recalculate July 16–31, then compare both periods employee by employee
   against the restored workbook.
4. Capture the remaining rate-change and post-finalization-correction scenario
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
