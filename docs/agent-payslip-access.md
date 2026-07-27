# Agent payslip access

Every agent receives `view_own_payslips`. This permission is limited by
row-level security to payslips belonging to the signed-in employee, and will
support viewing, downloading, and printing finalized payslips when the agent
payslip page is introduced.

Agent printing does not require `export_payslips`. Export remains restricted
to approved payroll administrators: the protected system administrator,
Almar, or a user explicitly trusted with payroll finalization or
all-employee-payslip access.

The database automatically grants own-payslip access to future agent profiles,
prevents that standard agent permission from being revoked, and rejects
unauthorized export grants.
