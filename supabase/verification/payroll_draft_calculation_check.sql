-- Phase 2 Step 7 deployment and calculation invariants.
select
  to_regprocedure('public.payroll_calculate_draft(uuid)') is not null
    as draft_calculator_exists_should_be_true,
  to_regprocedure('public.payroll_get_period_calculation(uuid)') is not null
    as calculation_review_exists_should_be_true,
  has_function_privilege(
    'anon',
    'public.payroll_calculate_draft(uuid)',
    'execute'
  ) as anon_can_calculate_should_be_false,
  has_function_privilege(
    'authenticated',
    'public.payroll_calculate_draft(uuid)',
    'execute'
  ) as authenticated_can_calculate_should_be_true;

select count(*) as own_draft_record_policy_count_should_be_zero
from pg_policies
where schemaname = 'public'
  and tablename in ('payroll_periods', 'payroll_records', 'payroll_items')
  and (
    coalesce(qual, '') ilike '%view_own_payslips%'
    or coalesce(with_check, '') ilike '%view_own_payslips%'
  )
  and coalesce(qual, '') not ilike '%finalized%';

with item_totals as (
  select
    record.id,
    coalesce(sum(item.amount) filter (
      where item.item_type = 'earning'
    ), 0)::numeric(14,2) as gross_pay,
    coalesce(sum(item.amount) filter (
      where item.item_type = 'deduction'
    ), 0)::numeric(14,2) as total_deductions
  from public.payroll_records as record
  left join public.payroll_items as item
    on item.payroll_record_id = record.id
  where record.calculated_at is not null
  group by record.id
)
select count(*) as record_total_mismatch_count_should_be_zero
from public.payroll_records as record
join item_totals as totals on totals.id = record.id
where record.gross_pay is distinct from totals.gross_pay
   or record.total_deductions is distinct from totals.total_deductions
   or record.net_pay is distinct from (
     totals.gross_pay - totals.total_deductions
   );

select count(*) as negative_net_pay_count_should_be_zero
from public.payroll_records
where net_pay < 0;

select
  period.id as payroll_period_id,
  period.period_start,
  period.period_end,
  count(record.id) filter (
    where record.calculated_at is not null
  ) as calculated_employee_count,
  coalesce(sum(record.gross_pay), 0)::numeric(14,2) as gross_pay,
  coalesce(sum(record.total_deductions), 0)::numeric(14,2)
    as total_deductions,
  coalesce(sum(record.net_pay), 0)::numeric(14,2) as net_pay
from public.payroll_periods as period
left join public.payroll_records as record
  on record.payroll_period_id = period.id
 and record.status <> 'void'
group by period.id, period.period_start, period.period_end
order by period.period_start, period.id;
