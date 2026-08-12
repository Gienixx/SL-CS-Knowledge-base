# Jean Vestil — July 16–31, 2026 payroll reconciliation

## Final decision

The revised payroll result is correct under the current approved rules. The
historical workbook/payslip is comparison evidence, not an exact acceptance
target for the revised payroll calculation.

| Measure | Revised payroll | Historical workbook/payslip |
| --- | ---: | ---: |
| Total billed time | 10,136 min (168h 56m) | 10,080 min (168h) |
| Base pay at $3.20/hour | $540.59 | $537.60 |
| Reimbursement | $150.00 | — |
| Bug incentive | $0.25 | — |
| Gross/net | $690.84 | $687.85 |

The accepted variance is **+56 minutes / +$2.99**. This is not a confirmed
payroll-engine bug.

## Proven causes of the five date deltas

| Date | Cause | Current result under agreed rules | Historical treatment | Decision |
| --- | --- | --- | --- | --- |
| Jul 17 | Approved billed attendance contributes 270 minutes. The workbook manually deducts 210 minutes as a prior-cutoff offset and retains 60 minutes. | Correct. | Legacy prior-cutoff deduction. | No payroll fix. |
| Jul 27 | The actual prepaid source is 840 minutes while the workbook shows 870 minutes. | Correct for the prepaid source. | Historical value differs from the prepaid source. | Do not change the source to match the workbook. |
| Jul 28 | The 960-minute prepaid line is accompanied by a distinct, approved 8-minute attendance line. | Correct: both payable sources are included. | The workbook does not include the additional 8 attendance minutes. | No payroll fix. |
| Jul 30 | The original prepaid source is 960 minutes. Its 598 settled minutes and 362 remaining minutes are FIFO balance state; settlement does not reduce the original prepaid earning. | Correct: the original 960 prepaid minutes are paid once. | Legacy workbook uses 600 minutes. | No payroll fix. |
| Jul 31 | Current approved billed attendance is 798 minutes. The workbook has a different attendance duration and a separate 420-minute offset. | Correct for the approved attendance source. | Legacy +420-minute carry-forward plus different attendance duration. | Do not treat the carry-forward as Jul 31 attendance. |

The date deltas are:

```text
Jul 17   +210
Jul 27    -30
Jul 28     +8
Jul 30   +360
Jul 31   -492
          ----
           +56 minutes
```

## Policy for future payroll periods

Revised payroll must continue to use:

- approved billed attendance as the source for worked time;
- prepaid hours paid once when the approved prepaid source is created;
- FIFO settlement only to reduce the remaining prepaid balance, not the original earning;
- independently payable approved paid leave; and
- no overtime, rest-day, or holiday premium rates.

Do not introduce payroll adjustments solely to reproduce Jean's historical
168-hour result. The historical values remain labeled **legacy comparison
values**. Future controlled payroll periods, rather than this historical
workbook, are the acceptance gate for validating the revised payroll system.

No payroll, attendance, prepaid data, or calculation logic was changed for
this decision.
