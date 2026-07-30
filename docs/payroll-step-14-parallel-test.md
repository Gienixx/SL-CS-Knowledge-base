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
- Employees loaded: 10 payroll records, including one zero-pay test profile
  that must be explicitly included or excluded by the payroll owner.
- Calculated records: 10.
- Blocking exceptions: 0.
- System gross pay: USD 7,466.06.
- System deductions: USD 0.00.
- System net pay: USD 7,466.06.
- Prepaid minutes added: 25,800.
- Prepaid minutes applied: 25,800.
- Production status remains Draft.

### Period 2 — July 16–31

- Status: not ready for calculation.
- Employees loaded: 11 payroll records, including two test profiles that must
  be explicitly included or excluded by the payroll owner.
- Calculated records: 0.
- Review-required attendance: 103 records across 9 employees. Each currently
  appears as both an incomplete-attendance and unapproved-attendance blocking
  exception because payroll readiness requires approval.
- Open clock-outs on July 30: 4.
- Missing attendance entries: 5 across 2 profiles, consisting of four Almar
  schedules dated July 28–31 and one `test test` schedule dated July 27.
- Missing rate: the `test test` profile has no rate effective on July 31.
- Valid carry-forward warnings: 33 unresolved prepaid balances across 8
  employees. These warnings are non-blocking when the balances are valid.
- Production status remains Draft.

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

1. The approved `2026 Support Timesheet.xlsx` source used during the prepaid
   import is no longer present at its prior Downloads path or in the available
   workspace attachments. It must be reattached or restored before manual
   totals can be compared.
2. July 16–31 cannot be calculated until completed attendance is approved,
   current open shifts are closed, missing attendance is resolved or approved
   as prepaid, and the missing effective-dated rate is added.
3. The payroll owner must confirm whether the `Test` and `test test` profiles
   are legitimate paid employees for these periods. If they are test accounts,
   their payroll records should be voided or excluded through an approved,
   audited payroll workflow instead of assigning invented rates or attendance.
4. July 16–31 currently has a July 31 payment date. That leaves no work date
   after payment and therefore no date eligible for the period's prepaid
   schedule workflow. If payroll is actually paid two or three days early, the
   payroll owner must confirm the correct payment date before any period date
   is changed or July 31 is treated as prepaid.

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
