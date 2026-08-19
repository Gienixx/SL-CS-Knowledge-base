-- Phase 2 Step 12: private, append-only payslip PDF versions.

begin;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'payroll-payslips',
  'payroll-payslips',
  false,
  5242880,
  array['application/pdf']::text[]
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.payslip_versions (
  id uuid primary key default gen_random_uuid(),
  payslip_id uuid not null
    references public.payslips(id) on delete restrict,
  payroll_record_id uuid not null
    references public.payroll_records(id) on delete restrict,
  document_version integer not null,
  template_version text not null,
  storage_bucket text not null,
  storage_path text not null,
  file_sha256 text not null,
  file_size_bytes bigint not null,
  generated_by uuid not null
    references public.profiles(user_id) on delete restrict,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint payslip_versions_record_version_key
    unique (payroll_record_id, document_version),
  constraint payslip_versions_payslip_version_key
    unique (payslip_id, document_version),
  constraint payslip_versions_storage_object_key
    unique (storage_bucket, storage_path),
  constraint payslip_versions_version_check
    check (document_version > 0),
  constraint payslip_versions_template_not_blank
    check (length(trim(template_version)) > 0),
  constraint payslip_versions_bucket_check
    check (storage_bucket = 'payroll-payslips'),
  constraint payslip_versions_path_not_blank
    check (length(trim(storage_path)) > 0),
  constraint payslip_versions_sha256_check
    check (file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint payslip_versions_file_size_check
    check (file_size_bytes between 1 and 5242880)
);

create index payslip_versions_latest_idx
  on public.payslip_versions (
    payroll_record_id,
    document_version desc
  );

create index payslip_versions_generated_by_idx
  on public.payslip_versions (
    generated_by,
    generated_at desc
  );

alter table public.payslip_versions enable row level security;

revoke all on table public.payslip_versions
  from public, anon, authenticated;
grant all on table public.payslip_versions
  to service_role;

create trigger payslip_versions_immutable
before update or delete on public.payslip_versions
for each row
execute function public.payroll_prevent_final_history_mutation();

create or replace function public.payroll_register_payslip_version(
  p_payroll_record_id uuid,
  p_storage_bucket text,
  p_storage_path text,
  p_file_sha256 text,
  p_file_size_bytes bigint,
  p_template_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_record public.payroll_records%rowtype;
  v_period public.payroll_periods%rowtype;
  v_payslip public.payslips%rowtype;
  v_version public.payslip_versions%rowtype;
  v_document_version integer;
  v_payslip_number text;
  v_storage_bucket text := trim(coalesce(p_storage_bucket, ''));
  v_storage_path text := trim(coalesce(p_storage_path, ''));
  v_file_sha256 text := lower(trim(coalesce(p_file_sha256, '')));
  v_template_version text := upper(trim(coalesce(p_template_version, '')));
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('export_payslips') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to generate payslip PDFs.';
  end if;

  if p_payroll_record_id is null then
    raise exception
      using errcode = '22023', message = 'Payroll record is required.';
  end if;

  if v_storage_bucket <> 'payroll-payslips' then
    raise exception
      using errcode = '22023', message = 'Invalid payslip storage bucket.';
  end if;

  if v_storage_path = ''
     or v_storage_path !~ (
       '^[0-9a-f-]{36}/' ||
       p_payroll_record_id::text ||
       '/[0-9a-f-]{36}\.pdf$'
     ) then
    raise exception
      using errcode = '22023', message = 'Invalid payslip storage path.';
  end if;

  if v_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception
      using errcode = '22023', message = 'Invalid payslip file digest.';
  end if;

  if p_file_size_bytes is null
     or p_file_size_bytes < 1
     or p_file_size_bytes > 5242880 then
    raise exception
      using errcode = '22023', message = 'Invalid payslip file size.';
  end if;

  if v_template_version <> 'A4-V1' then
    raise exception
      using errcode = '22023', message = 'Unsupported payslip template.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.payroll_payslip:' || p_payroll_record_id::text,
      0
    )
  );

  select record.*
  into v_record
  from public.payroll_records as record
  where record.id = p_payroll_record_id;

  if not found then
    raise exception
      using errcode = 'P0002', message = 'Payroll record was not found.';
  end if;

  select period.*
  into strict v_period
  from public.payroll_periods as period
  where period.id = v_record.payroll_period_id;

  if v_storage_path !~ (
    '^' ||
    v_period.id::text ||
    '/' ||
    v_record.id::text ||
    '/[0-9a-f-]{36}\.pdf$'
  ) then
    raise exception
      using errcode = '22023', message = 'Invalid payslip storage path.';
  end if;

  if v_record.status <> 'finalized'
     or v_period.status <> 'finalized'
     or v_record.finalized_at is null
     or v_period.finalized_at is null then
    raise exception
      using
        errcode = '55000',
        message = 'Payslip PDFs can be generated only for finalized payroll.';
  end if;

  if not exists (
    select 1
    from storage.objects as object
    where object.bucket_id = v_storage_bucket
      and object.name = v_storage_path
      and coalesce(object.metadata ->> 'mimetype', '') = 'application/pdf'
  ) then
    raise exception
      using
        errcode = '55000',
        message = 'The private payslip PDF upload was not found.';
  end if;

  select payslip.*
  into v_payslip
  from public.payslips as payslip
  where payslip.payroll_record_id = v_record.id;

  if not found then
    v_payslip_number :=
      public.payroll_get_payslip_number(v_record.id);

    insert into public.payslips (
      payroll_record_id,
      employee_id,
      payslip_number,
      storage_bucket,
      storage_path,
      file_sha256,
      file_size_bytes,
      generated_by,
      generated_at,
      finalized_at
    )
    values (
      v_record.id,
      v_record.employee_id,
      v_payslip_number,
      v_storage_bucket,
      v_storage_path,
      v_file_sha256,
      p_file_size_bytes,
      v_actor_user_id,
      statement_timestamp(),
      v_record.finalized_at
    )
    returning *
    into v_payslip;
  else
    v_payslip_number := v_payslip.payslip_number;
  end if;

  select coalesce(max(version.document_version), 0) + 1
  into v_document_version
  from public.payslip_versions as version
  where version.payroll_record_id = v_record.id;

  insert into public.payslip_versions (
    payslip_id,
    payroll_record_id,
    document_version,
    template_version,
    storage_bucket,
    storage_path,
    file_sha256,
    file_size_bytes,
    generated_by,
    generated_at
  )
  values (
    v_payslip.id,
    v_record.id,
    v_document_version,
    v_template_version,
    v_storage_bucket,
    v_storage_path,
    v_file_sha256,
    p_file_size_bytes,
    v_actor_user_id,
    statement_timestamp()
  )
  returning *
  into v_version;

  insert into public.payroll_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    payroll_period_id,
    payroll_record_id,
    after_data,
    metadata
  )
  values (
    v_actor_user_id,
    'payslip_pdf_generated',
    'payslip_version',
    v_version.id,
    v_record.payroll_period_id,
    v_record.id,
    jsonb_build_object(
      'payslip_id', v_payslip.id,
      'payslip_number', v_payslip_number,
      'document_version', v_document_version,
      'template_version', v_template_version,
      'file_sha256', v_file_sha256,
      'file_size_bytes', p_file_size_bytes
    ),
    jsonb_build_object(
      'storage_bucket', v_storage_bucket,
      'storage_path', v_storage_path
    )
  );

  return jsonb_build_object(
    'payslip_id', v_payslip.id,
    'payslip_version_id', v_version.id,
    'payslip_number', v_payslip_number,
    'document_version', v_document_version,
    'template_version', v_template_version,
    'generated_at', v_version.generated_at
  );
end;
$$;

revoke all on function public.payroll_register_payslip_version(
  uuid,
  text,
  text,
  text,
  bigint,
  text
) from public, anon;
grant execute on function public.payroll_register_payslip_version(
  uuid,
  text,
  text,
  text,
  bigint,
  text
) to authenticated, service_role;

comment on table public.payslip_versions is
  'Append-only private PDF versions for one immutable finalized payslip.';
comment on function public.payroll_register_payslip_version(
  uuid,
  text,
  text,
  text,
  bigint,
  text
) is
  'Registers an uploaded private A4 payslip PDF after enforcing finalization and export permission.';

commit;
