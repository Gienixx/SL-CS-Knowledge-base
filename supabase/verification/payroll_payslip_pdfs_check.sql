-- Phase 2 Step 12 private payslip PDF deployment and invariants.
select
  bucket.public is false as bucket_is_private_should_be_true,
  bucket.file_size_limit = 5242880
    as bucket_limit_is_five_mb_should_be_true,
  bucket.allowed_mime_types = array['application/pdf']::text[]
    as bucket_is_pdf_only_should_be_true,
  to_regclass('public.payslip_versions') is not null
    as version_table_exists_should_be_true,
  to_regprocedure(
    'public.payroll_register_payslip_version(uuid,text,text,text,bigint,text)'
  ) is not null as register_function_exists_should_be_true,
  has_table_privilege(
    'authenticated',
    'public.payslip_versions',
    'select'
  ) as browser_can_read_versions_should_be_false,
  has_function_privilege(
    'anon',
    'public.payroll_register_payslip_version(uuid,text,text,text,bigint,text)',
    'execute'
  ) as anon_can_register_should_be_false,
  has_function_privilege(
    'authenticated',
    'public.payroll_register_payslip_version(uuid,text,text,text,bigint,text)',
    'execute'
  ) as authenticated_can_call_guarded_register_should_be_true
from storage.buckets as bucket
where bucket.id = 'payroll-payslips';

select count(*) as public_storage_policy_count_should_be_zero
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
  and (
    coalesce(qual, '') ilike '%payroll-payslips%'
    or coalesce(with_check, '') ilike '%payroll-payslips%'
  );

select count(*) as invalid_version_count_should_be_zero
from public.payslip_versions as version
join public.payslips as payslip
  on payslip.id = version.payslip_id
join public.payroll_records as record
  on record.id = version.payroll_record_id
join public.payroll_periods as period
  on period.id = record.payroll_period_id
where payslip.payroll_record_id <> version.payroll_record_id
  or record.status <> 'finalized'
  or period.status <> 'finalized'
  or version.storage_bucket <> 'payroll-payslips'
  or version.template_version <> 'A4-V1'
  or version.file_size_bytes not between 1 and 5242880
  or version.file_sha256 !~ '^[0-9a-f]{64}$';

select count(*) as missing_storage_object_count_should_be_zero
from public.payslip_versions as version
left join storage.objects as object
  on object.bucket_id = version.storage_bucket
 and object.name = version.storage_path
where object.id is null
   or coalesce(object.metadata ->> 'mimetype', '') <> 'application/pdf';

select
  tgname,
  tgenabled
from pg_trigger
where tgrelid = 'public.payslip_versions'::regclass
  and tgname = 'payslip_versions_immutable';

select
  action,
  count(*) as generation_audit_count
from public.payroll_audit_logs
where action = 'payslip_pdf_generated'
group by action;
