# Phase 2 — Rates, Payroll, and Payslips

## Objective

Use approved Phase 1 attendance and explicitly approved pre-plotted schedules
to calculate payroll, preserve historical rates, reconcile hours paid before
they are rendered, generate private payslips, and keep finalized payroll
records immutable.

## Confirmed payroll rules

1. Payroll uses USD as its accounting currency. PHP values are reference
   conversions only and do not replace the stored USD amounts.
2. Regular earnings use approved regular minutes and the hourly rate effective
   on the work date.
3. Daily rate is hourly rate multiplied by 8. Monthly rate is hourly rate
   multiplied by 176.
4. Payroll may be paid two or three days before the 15th or 30th cutoff.
5. Approved schedules after the payment date may be paid as pre-plotted hours.
6. Agents still clock in and out normally on pre-plotted dates.
7. If actual regular plus eligible overtime minutes are lower than the prepaid
   minutes, the remaining prepaid balance carries forward until rendered.
8. The oldest prepaid balance is settled first.
9. Approved regular minutes settle prepaid balances before normal overtime
   minutes. Normal pre-shift and post-shift overtime may settle a balance
   one-for-one without an overtime premium.
10. Holiday, rest-day, and other guaranteed special-day work never settles a
    prepaid balance. It remains additional payable work.
11. If actual eligible minutes exceed all prepaid balances, the excess is paid
    in the next payroll when it was recorded after the prior payroll was
    finalized.
12. Prepaid balances are tracked in minutes, not as monetary deductions.
13. Attendance records are never edited to perform payroll reconciliation.
14. There are no statutory or government deductions.
15. Authorized payroll users may enter manual deductions with a required
    reason. Private payroll notes must not appear on an agent's payslip.
16. Finalized payroll and payslips are immutable. Later attendance changes
    create a future-period adjustment or use the controlled reopening process.

## Revised implementation steps

### Step 1 — Create and extend payroll tables

Create and retain:

- `agent_rates`
- `payroll_periods`
- `payroll_records`
- `payroll_items`
- `payroll_attendance_snapshots`
- `payslips`
- `payroll_audit_logs`

Add for prepaid-hour reconciliation:

- `payroll_schedule_snapshots`
  - Immutable copy of each approved pre-plotted schedule used in payroll.
  - Stores the scheduled date, scheduled minutes, schedule version, special-day
    classification, approval details, and snapshot time.
- `payroll_prepaid_hours`
  - Stores prepaid minutes, settled minutes, remaining minutes, source payroll
    record, source schedule snapshot, and status.
- `payroll_hour_allocations`
  - Append-only history showing which later approved attendance minutes settled
    each prepaid balance.

Requirements:

- Enable RLS on every payroll table.
- Keep rate, pay, reconciliation, and payslip data private.
- Do not allow browser users to insert or modify ledger rows directly.
- Add indexes for employee, work date, source payroll, destination payroll, and
  unsettled FIFO lookups.
- Never overwrite attendance, schedule, rate, payroll, or allocation history.

### Step 2 — Add payroll permissions

Maintain separate payroll permissions:

- `manage_agent_rates`
- `create_payroll`
- `review_payroll`
- `finalize_payroll`
- `view_all_payslips`
- `view_own_payslips`
- `export_payslips`
- `reopen_payroll`

General administrator status alone does not grant payroll access.

### Step 3 — Assign payroll permissions

Requirements:

- Every active agent receives `view_own_payslips`.
- Agents can view, download, and print only their own finalized payslips.
- Agents cannot view rates, another employee's payroll, or reconciliation
  records.
- `export_payslips` is limited to system administrators and approved payroll
  administrators.
- Payroll users cannot correct attendance unless they also have
  `correct_attendance`.
- All permission changes are audited.

### Step 4 — Manage effective-dated rates

Page:

- `agent-rates.html`

Support:

- Hourly rate
- Automatically calculated daily and monthly rates
- Overtime rate
- Holiday rate
- Effective date
- Rate-change reason
- Historical rates
- USD accounting values and PHP reference conversion

Requirements:

- Existing rate records are never overwritten.
- Payroll uses the rate effective on the original attendance or pre-plotted
  work date.
- A carried minute balance does not carry a monetary rate. Only newly payable
  minutes use the rate effective on their actual work date.

### Step 5 — Manage payroll periods and approved pre-plots

Pages:

- `payroll-dashboard.html`
- `payroll-period.html`

Authorized users can:

- Create a payroll period.
- Select start and end dates.
- Set a payment date before or on the cutoff date.
- Check overlapping periods.
- Load eligible employees.
- Identify missing rates and unresolved attendance.
- Select future scheduled shifts to be prepaid.
- Review scheduled minutes and special-day classification.
- Explicitly approve the pre-plotted schedule snapshot.
- Open an **Add prepaid schedule** form from the payroll-period page.
- Select the employee, work date, prepaid login, prepaid logout, and timezone.
- Review the automatically calculated prepaid minutes before approval.
- Add a required approval reason.

The payroll-period prepaid-entry form must use the employee's real work
schedule:

- If an eligible published or changed schedule already exists, load its
  login, logout, timezone, and scheduled minutes into the form.
- A user with both `create_payroll` and `manage_schedules` may create the
  missing employee schedule from the payroll workflow and then approve it.
- A payroll user without `manage_schedules` may approve an eligible existing
  schedule but cannot create or modify one. The page must identify that a
  schedule manager is required.
- Manually entered prepaid times must never be written to the `attendance`
  table or represented as completed work.

Requirements:

- Remove the rule that payment date must be on or after period end.
- A payment date cannot be outside the organization's allowed early-payment
  window without a payroll warning or documented override.
- Only published or changed schedules with complete shift times may be
  pre-plotted.
- Rest days and guaranteed special days must not create prepaid-hour debt.
- An approved pre-plot is not treated as missing attendance.
- The prepaid work date must fall after the payment date and within the payroll
  period.
- Duplicate employee, work-date, schedule, or schedule-version approvals must
  be rejected.
- Prepaid login and logout must produce a positive duration and must follow the
  schedule's timezone and overnight-shift rules.
- Creating or changing the source schedule and approving it for payroll are
  separately permission-checked and audited.

### Step 6 — Import approved attendance and pre-plotted schedules

Attendance import continues to load only payroll-ready attendance.

For every attendance import, snapshot:

- Attendance ID
- Employee ID
- Schedule ID
- Work date
- Clock-in and clock-out
- Regular minutes
- Pre-shift and post-shift overtime minutes
- Rest-day and holiday overtime minutes
- Total overtime minutes
- Late and undertime minutes
- Attendance version
- Special-day classification
- Import time

For every approved pre-plot, create an immutable schedule snapshot and prepaid
hour entry.

Requirements:

- Do not create fake attendance for future dates.
- Do not weaken the Phase 1 payroll-ready attendance rules.
- Attendance or schedule changes before finalization mark the affected payroll
  record for recalculation.
- Changes after finalization do not alter the finalized payroll. They are
  reconciled in a future period.
- Re-importing is idempotent and does not duplicate the same source version.

### Step 7 — Calculate draft payroll and reconcile prepaid hours

Calculate:

- Basic pay
- Approved regular hours or days
- Prepaid scheduled earnings
- Normal overtime
- Guaranteed special-day pay
- Additional special-day work
- Holiday pay
- Late deduction
- Undertime deduction
- Unpaid absence
- Allowances
- Bonuses
- Manual earnings
- Manual deductions
- Other adjustments

There are no government or statutory deductions.

Calculation order:

1. Lock and read the approved attendance and schedule snapshots.
2. Load the rate effective on each original work date.
3. Create the guaranteed special-day earnings.
4. Add approved pre-plotted earnings for eligible future ordinary workdays.
5. Load the employee's oldest unsettled prepaid balances.
6. Apply approved regular minutes first, followed by normal pre-shift and
   post-shift overtime minutes.
7. Do not apply holiday, rest-day, or guaranteed special-day work to prepaid
   balances.
8. Record every applied minute in `payroll_hour_allocations`.
9. Treat eligible minutes remaining after all balances are settled as newly
   payable minutes.
10. If those excess minutes were recorded after a source payroll was finalized,
    pay them in the next payroll period.
11. Round monetary line items to cents using the payroll period's explicit
    rounding rules.
12. Recalculate gross pay, total deductions, and net pay from detailed payroll
    items.

Net pay must not become negative. Any unresolved amount requires payroll review.

Late and undertime minutes are preserved as informational deduction lines, but
are not deducted a second time because approved regular earnings already use
only the minutes actually rendered. Internal arrangements, unpaid absence
amounts, and other deductions are added through the audited Step 9 manual
adjustment workflow. Government and statutory deductions remain unsupported.

### Step 8 — Review payroll exceptions

Display:

- Missing rate
- Incomplete attendance
- Unapproved attendance
- Missing clock-out
- Overtime above the review limit
- Duplicate attendance
- Overlapping schedules
- Payroll-period overlap
- Attendance changed after import
- Schedule changed after pre-plot approval
- Pre-plot missing payroll approval
- Pre-plot with invalid or missing scheduled minutes
- Duplicate hour allocation
- Prepaid balance with no valid source
- Unresolved prepaid balance

On the authorized team-attendance and payroll review interfaces, display:

- Prepaid login and logout from the approved schedule snapshot
- Prepaid minutes or hours
- Actual login and logout from attendance
- Actual eligible minutes
- Minutes applied to prepaid balances
- Remaining prepaid minutes
- Open, partially settled, settled, or void status

Requirements:

- Approved pre-plotted dates are not missing-attendance exceptions.
- A guaranteed special day without attendance is not a missing-attendance
  exception.
- Unresolved prepaid balances are visible but do not automatically block the
  current payroll when carrying them forward is valid.
- Invalid, duplicated, or unaudited balances are blocking exceptions.
- Exception links must take authorized users to the relevant attendance,
  schedule, rate, or payroll record without granting additional access.
- Prepaid display values must be calculated from
  `payroll_schedule_snapshots`, `payroll_prepaid_hours`, and
  `payroll_hour_allocations`; they must not be stored as replacement clock
  values on `attendance`.
- Applying later minutes to a prepaid balance must never change the employee's
  actual clock-in, clock-out, or approved attendance totals.

### Step 9 — Allow audited draft adjustments

Authorized users may add:

- Manual earnings
- Manual deductions
- Agent-visible descriptions
- Required adjustment reasons
- Private correction notes

Requirements:

- Every addition, edit, or removal is audited.
- Adjustments are allowed only while payroll is editable.
- Automated prepaid-hour allocations are not manual deductions.
- Government-deduction controls remain hidden and their value remains zero.
- Adjustment amounts are positive USD values rounded to cents.
- An adjustment cannot make employee net pay negative.
- Employee-visible descriptions remain on the payroll item.
- Private correction notes are stored only in payroll audit metadata and are
  never exposed through employee payroll items.
- Recalculating draft payroll preserves manual adjustments and rebuilds totals
  from all current item lines.

### Step 10 — Approve and finalize payroll

Before finalization:

- Recalculate every payroll record.
- Confirm no blocking exceptions.
- Confirm attendance snapshots.
- Confirm pre-plotted schedule snapshots.
- Confirm opening, added, applied, and closing prepaid-minute balances.
- Confirm rates and rounding rules used.
- Record the reviewer and approver.
- Record the finalization timestamp.

After finalization:

- Payroll records, items, snapshots, allocations, and payslips are immutable.
- Attendance and schedule corrections do not silently alter finalized payroll.
- Later eligible minutes settle prepaid balances through append-only
  allocations in a future payroll.
- Later excess minutes produce a future earning.
- Reopening requires `reopen_payroll`, a reason, a complete audit trail, and
  regeneration of affected payslips.

### Step 11 — Build payslip preview

Page:

- `payslip-preview.html`

Include:

- Employee information
- Payroll period
- Payment date
- Rates used
- Regular earnings
- Prepaid scheduled earnings
- Overtime and special-day earnings
- Other earnings
- Manual deductions
- Gross pay
- Total deductions
- Net pay
- Prepaid hours added
- Hours applied to prior prepaid balances
- Closing prepaid-hour balance
- Payslip number
- Approval information

Private payroll notes and another employee's information must never appear.

### Step 12 — Generate and store payslip PDFs

Requirements:

- Use a fixed A4 server-side template.
- Generate PDFs only from finalized payroll data.
- Store PDFs in a private Supabase Storage bucket.
- Provide temporary signed URLs.
- Never expose public file links.
- Do not place salary, rate, or payslip data in browser logs.
- Regenerated files must have a new audited version or follow controlled
  reopening rules.

### Step 13 — Provide agent payslip access

Page:

- `my-payslips.html`

Agents can:

- View their own finalized payslips.
- Download their own PDF.
- Print their own payslip.
- View their own prepaid-hour summary included on the payslip.

Agents cannot access another employee's payslip, rate, payroll record, private
note, or detailed reconciliation ledger.

### Step 14 — Run a two-period parallel payroll test

Process two consecutive payroll periods using:

- The existing manual process.
- The new payroll system.

Compare each employee's:

- Regular time
- Overtime
- Guaranteed special-day pay
- Prepaid hours added
- Prepaid hours settled
- Opening and closing prepaid balances
- Excess hours moved into the next payroll
- Gross pay
- Manual deductions
- Net pay

Required scenarios:

- Pre-plotted hours exactly matched.
- Pre-plotted hours partially rendered.
- A balance settled over multiple days.
- Normal overtime used to settle a balance.
- Actual hours exceeding all prepaid balances.
- Special-day work remaining additional and not settling a balance.
- Rate change between the source pre-plot and later attendance.
- Attendance correction after finalization.

Correct every discrepancy before production use.

### Step 15 — Run two linked controlled payroll periods

Use the new system for two linked controlled periods while retaining complete
manual verification.

Phase 2 becomes the primary payroll process only when:

- Both periods match the approved manual totals.
- Every prepaid balance can be traced from source to settlement.
- Excess hours appear in the correct later payroll.
- Special-day pay matches the confirmed rules.
- Permissions and payslip privacy are verified.
- Final approval is documented.

## Current implementation status

| Step | Status | Next requirement |
| --- | --- | --- |
| 1 | Complete | Reconciliation tables, schedule versioning, special-day snapshot fields, RLS, constraints, and indexes implemented |
| 2 | Complete | None |
| 3 | Complete and updated for own-payslip access | Continue regression testing |
| 4 | Complete | Calculator now selects the immutable rate effective on each original work date |
| 5 | Complete | Early-payment controls, eligible schedule review, immutable approval, and audit logging are implemented. The payroll-period page now includes **Add prepaid schedule**, calculated hours, existing-schedule loading, schedule-manager handoff, permission-aware creation or updates, exact-version approval, and server validation that never writes attendance. The 59 validated July 2026 ordinary pre-plots remain imported and visible |
| 6 | Complete | Approval creates prepaid balances; approved attendance imports remain immutable; existing July attendance was reconciled against the imported balances using the same FIFO rules |
| 7 | Complete | The atomic USD calculator uses approved attendance and prepaid snapshots, effective-dated rates, exact-minute conversion, half-up cent rounding, FIFO prepaid offsets, normal overtime, special-day guarantees and work premiums, itemized totals, recalculation versions, audit logs, and negative-net protection. Draft totals remain private to payroll processors |
| 8 | Complete | Core attendance and rate exceptions, all prepaid source/version/minute/audit/allocation checks, approved pre-plot exemptions, calculated Team Attendance prepaid columns, non-blocking carry-forward warnings, and exact permission-safe resolution links are implemented |
| 9 | Complete | Authorized payroll creators can add, edit, or remove manual earnings and deductions from calculated draft records. Every action requires a reason, rebuilds employee totals atomically, preserves a complete before/after audit event, keeps correction notes private, rejects negative net pay, and is blocked after payroll leaves draft or reopened status |
| 10 | Complete | Review recalculates stored employee totals and records calculation, snapshot, rate, rounding, and prepaid-balance evidence. Final approval reruns every gate, records reviewer/approver/timestamp, increments the finalization version, and locks periods, records, items, snapshots, destination allocations, payslips, and audit history. Controlled reopening requires separate permission and a reason, preserves prior evidence, and forces full recalculation. Once a PDF exists, that payroll remains blocked from reopening; later payroll corrections must use a future adjustment, while PDF-only regeneration appends a new immutable document version without changing finalized payroll |
| 11 | Complete | Finalized payroll now has a private A4 payslip preview with a stable payslip number, employee and period details, itemized earnings and deductions, prepaid balances, totals, and approval information. Payroll-wide viewers can inspect the effective rates used; agents using own-payslip access receive no rate or other-employee data. Private adjustment reasons and correction notes are excluded |
| 12 | Complete | Finalized payslips can be rendered server-side with the fixed `A4-V1` template, hashed with SHA-256, uploaded only to the private PDF-only `payroll-payslips` bucket, registered as append-only immutable document versions, and downloaded through two-minute signed URLs. Each generation is permission-checked and audited. The employee PDF omits rate fields so own-payslip access cannot reveal rates; payroll users retain rate verification in the secured Step 11 preview |
| 13 | Complete | Agents now have a permission-gated **My payslips** page for their own finalized payroll only, with prepaid-hour summaries, private preview, temporary signed PDF download, and print actions. The server-side list excludes rates, private notes, storage paths, and detailed reconciliation data |
| 14 | In progress | Both July periods are calculated in Draft with no blocking exceptions. July 16–31 contains 9 payable records totaling USD 7,824.41 gross and net, all 115 attendance snapshots are current, Almar's current July 28–31 prepaid versions are approved, and both testing-only profiles remain excluded. Obtain the signed manual payroll totals, complete the employee-by-employee variance comparison, capture the two remaining scenarios, and obtain owner approval |
| 15 | Not started | Begin only after every Step 14 discrepancy is corrected and approval is documented |

## Next implementation order

The July 2026 source-data bootstrap is complete:

- 59 ordinary pre-plotted schedules were imported from the approved workbook.
- 283 January-June rows were excluded because matching payroll periods do not
  exist in the website.
- 16 July OFF rows and one mixed RDOT row were excluded because they must not
  create ordinary prepaid-hour debt.
- No live attendance rows were created or changed by the import.
- Rollback-only integration tests passed for exact settlement, partial work,
  three-day carry-forward, regular-plus-overtime settlement, and rest-day and
  holiday exclusion.

The Step 7 controlled calculation for July 1–15 is complete:

- 10 employee records and 262 calculation lines were generated.
- 25,800 prepaid minutes were paid and exactly 25,800 allocated minutes were
  removed from later payable attendance, preventing duplicate payment.
- Stored gross and net pay are both USD 7,466.06 before Step 9 adjustments.
- Stored record totals exactly match the detailed earnings and deduction lines.
- The July 16–31 period remains uncalculated because its 208 blocking
  attendance exceptions are correctly preventing calculation.

Step 9 is deployed without adding any production adjustment:

- The July 1–15 controlled payroll remains USD 7,466.06 gross and net.
- No manual earning or deduction exists until an authorized payroll user adds
  one for a documented business reason.
- Rollback-only tests passed for add, edit, remove, private notes, total
  rebuilding, negative-net rejection, audit history, and finalized lockout.

Step 10 is deployed without finalizing the production July payroll:

- Review, approval, finalization, immutable locks, and controlled reopening are
  available only through their separate payroll permissions.
- Finalization evidence preserves every employee calculation version, rates
  used, rounding rules, attendance and schedule snapshot counts, and each
  employee's opening, added, applied, and closing prepaid minutes.
- Rollback-only integration tests completed review, finalization, direct
  mutation lock checks, and reopening. The July 1–15 production period remains
  in Draft with no approval or finalization record.
- Attendance and schedule corrections cannot silently rewrite finalized
  payroll. Later eligible work continues through append-only future-period
  reconciliation, while other corrections require a future adjustment or the
  controlled reopening process.

Step 11 is deployed without finalizing the production July payroll:

- The finalized payroll page links each employee record to a fixed A4 payslip
  preview.
- The preview uses only immutable Step 10 totals, item lines, rate references,
  prepaid-balance evidence, and approval information.
- A stable payslip number is derived from the payment date, employee number,
  payroll record, and finalization version until Step 12 stores the generated
  PDF record.
- Payroll-authorized viewers can verify rates. Agents with own-payslip access
  receive the same finalized earnings and totals without rates, private notes,
  or access to another employee.
- A rollback-only live test passed payroll-viewer access, own-agent access,
  rate removal, stable numbering, and cross-employee denial. The July 1–15
  production period remains in Draft.

Step 12 is implemented without generating a production payslip:

- The server renders a fixed A4 PDF from finalized immutable Step 10 and Step
  11 values. Long itemized payslips continue cleanly across A4 pages with
  repeated headers and page numbers.
- Employee PDF files contain finalized earnings, deductions, totals, prepaid
  balances, and approval evidence, but no rates, correction notes, adjustment
  reasons, or browser console output.
- Files are restricted to PDF, capped at 5 MB, hashed with SHA-256, and stored
  in the private `payroll-payslips` bucket. There is no public Storage policy.
- Every generation or regeneration appends an immutable document version and
  a payroll audit event. Prior versions and files remain preserved.
- Downloads are authorized against the requested payslip before the server
  returns a private signed URL that expires after two minutes.
- The Cloudflare Pages Functions bundle compiled successfully. A rendered
  two-page sample passed A4 sizing, pagination, alignment, totals, and
  rate/private-note exclusion checks.
- Live rollback-only checks confirmed that a missing private upload cannot be
  registered and an agent cannot generate PDFs. The July 1–15 production
  period remains in Draft with no payslip or PDF version.

Step 13 is implemented without finalizing production payroll:

- **My payslips** is available from each permitted employee's Home sidebar and
  lists only the current authenticated employee's finalized payroll records.
- Each row shows its payroll period, payment date, gross pay, deductions, net
  pay, prepaid-hour summary, finalization information, and private-PDF status.
- Employees can open the secured Step 11 preview, download the latest Step 12
  PDF through a two-minute signed URL, or open the preview directly in print
  mode.
- The list function requires `view_own_payslips` and checks the current
  workforce identity again in PostgreSQL. It returns no rates, private
  correction or adjustment notes, storage paths, other employee data, or
  detailed prepaid reconciliation ledger.
- Live verification confirmed the anonymous role cannot call the list,
  authenticated access remains permission guarded, and an active agent
  receives an empty finalized list while production contains only Draft
  payroll. No production payroll, payslip, PDF version, or Storage object was
  created.

Step 14 started on July 30, 2026:

- July 1–15 has 9 payable calculated records, no blocking exceptions,
  USD 7,466.06 gross and net pay, and 25,800 prepaid minutes fully applied.
  The separate testing-only `Test` profile's zero-pay record is void and
  preserved for audit history.
- The rollback-only exact-match, partial-work, multi-day carry-forward,
  overtime-settlement, and special-day-exclusion scenarios passed again with
  no persistent synthetic records.
- July 16–31 has 9 payable calculated records, no blocking exceptions,
  USD 7,824.41 gross and net pay, USD 0.00 deductions, 36,300 prepaid minutes
  added, 22,172 applied, and 14,128 carried forward. All 115 attendance
  snapshots are current and all records are ready for review.
- July 16–31 is configured with the confirmed July 27 payment date and the
  audited four-day early-payment override.
- The approved `2026 Support Timesheet.xlsx` manual source was restored on
  August 3. Almar's current July 28–31 schedule versions are approved as
  prepaid sources using the workbook's LOG IN / LOG OUT columns. The four
  stale version-2 balances are void and linked to their replacements.
- The detailed run record and completion controls are in
  `docs/payroll-step-14-parallel-test.md`.

1. Obtain the signed manual payroll report; the support timesheet does not
   contain approved employee-level gross, deduction, or net totals.
2. Complete every employee comparison and the remaining rate-change and
   post-finalization-correction scenarios, then correct all differences.
3. Continue to Step 15 only after Step 14 approval is signed and dated.
