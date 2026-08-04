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
- Arby's July 29 and July 30 attendance is approved at the workbook LOG IN /
  LOG OUT times of 12:00 AM–6:00 PM and 12:30 AM–6:30 PM, respectively. The
  corrected versions are imported and the Draft calculation is current.
- Restored manual source: `2026 Support Timesheet.xlsx` is available again at
  its Downloads path as of August 3. Its SHA-256 is
  `949d4e4547f92829a3a631e8d7b4712e45fedeac8a1ad14245cdcd231b47d590`.
- Missing-rate exceptions: 0 after excluding the testing-only profile.
- System gross pay: USD 7,805.90.
- System deductions: USD 0.00.
- System net pay: USD 7,805.90.
- Prepaid minutes added: 36,300.
- Prepaid minutes applied: 22,176.
- Closing prepaid-minute balance: 14,124.
- Blocking exceptions: 0.
- Valid carry-forward warnings: 18 unresolved prepaid balances. These warnings
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
| Arby Jann Benito | 3,840 | 4,020 | 1,620 | 4,320 | 3,240 | 1,080 | 4,620 | 124.80 | 774.40 | 0.00 | 774.40 |
| Arez Santos | 4,050 | 5,670 | 1,890 | 2,760 | 720 | 2,040 | 9,000 | 164.50 | 892.50 | 0.00 | 892.50 |
| Genevive Serrano | 4,200 | 5,292 | 960 | 3,420 | 3,304 | 116 | 6,188 | 56.00 | 809.19 | 0.00 | 809.19 |
| Jean Vestil | 2,510 | 1,578 | 1,368 | 3,720 | 3,358 | 362 | 730 | 89.92 | 506.35 | 0.00 | 506.35 |
| Jerson Gavileño | 3,360 | 3,210 | 1,800 | 4,800 | 982 | 3,818 | 5,588 | 167.20 | 887.30 | 0.00 | 887.30 |
| Leufard Vallega | 2,869 | 2,222 | 660 | 4,200 | 4,200 | 0 | 891 | 72.20 | 660.63 | 0.00 | 660.63 |
| **Total** | **32,709** | **33,216** | **17,538** | **36,300** | **22,176** | **14,124** | **43,749** | **1,631.42** | **7,805.90** | **0.00** | **7,805.90** |

The supplied support timesheet contains the source schedule and login/logout
activity but no signed manual gross-pay, deduction, or net-pay totals. Manual
values and variances must therefore remain pending until the approved manual
payroll report is provided; they must not be inferred from the activity log.

### July manual-evidence availability decision

On August 3, 2026, the payroll owner confirmed that July 1–15 and July 16–31
manual payslips can be provided for Arby Jann Benito only. The equivalent
historical manual payroll evidence is unavailable for the other eight payable
employees:

- Alen Tristan Adeva
- Almar Contreras
- Amora Angeles
- Arez Santos
- Genevive Serrano
- Jean Vestil
- Jerson Gavileño
- Leufard Vallega

Those eight employees must be recorded as `Manual evidence unavailable` for
both July periods. Missing manual amounts must not be entered as zero,
estimated from February, copied from another employee, or reverse-calculated
from the July system result.

This owner-approved evidence scope permits a documented partial July
comparison for Arby. It does not satisfy the full-population completion gate
defined for Step 14. Both July payroll periods therefore remain Draft and the
historical evidence limitation remains open until a later full-population,
two-period parallel run is completed or the project governance standard is
formally revised and approved.

#### Arby July payslip comparison

The payroll owner supplied two manual payslip screenshots on August 3, 2026:

- July 1–15: `C:\Users\Gienixx\Downloads\image (1).png`, SHA-256
  `26305e600a0197f7e862266880c3f38ef6152d2b05628b2a6b55bdfb23c6f00c`.
- July 16–31: `C:\Users\Gienixx\Downloads\image.png`, SHA-256
  `16ab381362d86d0b472411aa3b6ee1cf7a8221fd9a1d413d717cf8afb3ed5c4e`.

Both screenshots identify Arby Jann Benito and an hourly rate of USD 3.20.
They do not split billed hours into regular, overtime, special-day, or prepaid
categories and do not show a reviewer signature or approval date. Blank
deduction fields are treated as an implied USD 0.00 only because gross and net
pay are identical; the source does not provide a separate deduction total.

Variance below is `System - Manual`. `System earning hours` is the sum of the
quantities on the Draft system earning items; it is not presented as a direct
replacement for the payslip's unsplit `Total Billed Hours` field.

| Period | Manual billed hours | System earning hours | Hour variance | Manual base pay | Manual other earnings | Manual gross/net | System gross/net | Gross/net variance |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Jul 1–15 | 206.0000 | 205.0000 | -1.0000 | 659.20 | 200.81 | 860.01 | 686.40 | -173.61 |
| Jul 16–31 | 230.0000 | 230.0000 | 0.0000 | 736.00 | 1.00 | 737.00 | 774.40 | +37.40 |

Manual other earnings for July 1–15 are a USD 41.94 internet reimbursement,
USD 83.87 work-peripheral reimbursement, and USD 75.00 performance bonus.
July 16–31 contains a USD 1.00 bug incentive. None of these four manual items
currently exists in the Draft system payroll.

The underlying system earning-item reconciliation is internally consistent:

- Jul 1–15: 205.0000 earning hours at the USD 3.20 base rate produce USD
  656.00, plus USD 30.40 of additional rest-day-excess premium, totaling USD
  686.40.
- Jul 16–31: the approved July 29 attendance is 12:00 AM–6:00 PM and July 30
  is 12:30 AM–6:30 PM, exactly matching ARBY rows 284–285 in the validated
  workbook. The 230.0000 earning hours produce USD 736.00 at the confirmed
  USD 3.20 rate, plus USD 38.40 of additional rest-day-excess premium,
  totaling USD 774.40.

Adding the payslip-only reimbursements and incentives to the system without
changing its approved prepaid and special-day rules would produce USD 887.21
for Jul 1–15 and USD 775.40 for Jul 16–31. Those adjusted figures would remain
USD 27.20 and USD 38.40 above the manual payslips, respectively. Therefore the
variance is not merely missing manual earnings; it also reflects different
billed-hour and special-day treatment. No Draft adjustment was entered because
the payroll owner must first approve each reimbursement/incentive and decide
whether the manual or system treatment is authoritative.

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

1. Resolve Arby Jann Benito's two documented July policy variances and obtain the
   payroll owner's approval for any Draft reimbursements or incentives.
2. Keep the other eight employees marked `Manual evidence unavailable`; do
   not infer missing manual values or count them as reconciled.
3. Plan a later full-population, two-period parallel run because the July
   evidence set cannot meet the existing Step 14 completion gate.
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
