import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import {
  generatePayslipPdf,
  PAYSLIP_PDF_TEMPLATE_VERSION
} from '../functions/_shared/payslip-pdf.js'

const migrationPath =
  'supabase/migrations/20260729213543_generate_private_payslip_pdfs.sql'

function samplePreview(itemCount = 2) {
  return {
    payslip_number: 'SL-20260715-SL0001-12345678-V1',
    employee: {
      full_name: 'Sample Employee',
      employee_number: 'SL-0001',
      email: 'sample@example.com'
    },
    period: {
      payroll_period_id: '11111111-1111-4111-8111-111111111111',
      period_start: '2026-07-01',
      period_end: '2026-07-15',
      payment_date: '2026-07-15',
      currency_code: 'USD'
    },
    earnings: Array.from({ length: itemCount }, (_, index) => ({
      description: 'Approved regular earnings',
      work_date: `2026-07-${String((index % 15) + 1).padStart(2, '0')}`,
      quantity: 8,
      unit_rate: 100,
      amount: 64
    })),
    deductions: [{
      description: 'Internal arrangement deduction',
      amount: 25,
      unit_rate: 100,
      is_manual: true
    }],
    totals: {
      regular_earnings: 1600,
      prepaid_scheduled_earnings: 320,
      overtime_earnings: 96,
      rest_day_earnings: 0,
      holiday_earnings: 128,
      other_earnings: 20,
      gross_pay: 2164,
      total_deductions: 25,
      net_pay: 2139
    },
    prepaid_summary: {
      opening_minutes: 480,
      added_minutes: 960,
      applied_minutes: 720,
      closing_minutes: 720
    },
    approval: {
      reviewed_by_name: 'Payroll Reviewer',
      reviewed_at: '2026-07-16T01:00:00Z',
      approved_by_name: 'Payroll Approver',
      approved_at: '2026-07-16T02:00:00Z',
      finalized_by_name: 'Payroll Approver',
      finalized_at: '2026-07-16T02:00:00Z'
    }
  }
}

test('Step 12 creates a private PDF-only bucket and append-only versions', async () => {
  const migration = await readFile(migrationPath, 'utf8')

  assert.match(migration, /'payroll-payslips'/)
  assert.match(migration, /public = false/)
  assert.match(migration, /5242880/)
  assert.match(migration, /array\['application\/pdf'\]::text\[\]/)
  assert.match(migration, /create table public\.payslip_versions/)
  assert.match(migration, /unique \(payroll_record_id, document_version\)/)
  assert.match(migration, /create trigger payslip_versions_immutable/)
  assert.match(migration, /payroll_prevent_final_history_mutation/)
  assert.match(migration, /revoke all on table public\.payslip_versions[\s\S]*?authenticated/)
})

test('PDF registration requires finalized payroll, export access, upload evidence, and audit history', async () => {
  const migration = await readFile(migrationPath, 'utf8')

  assert.match(migration, /payroll_register_payslip_version/)
  assert.match(migration, /workforce_has_permission\('export_payslips'\)/)
  assert.match(migration, /v_record\.status <> 'finalized'/)
  assert.match(migration, /v_period\.status <> 'finalized'/)
  assert.match(migration, /from storage\.objects as object/)
  assert.match(migration, /object\.metadata ->> 'mimetype'/)
  assert.match(migration, /pg_advisory_xact_lock/)
  assert.match(migration, /payslip_pdf_generated/)
  assert.match(migration, /document_version/)
  assert.match(migration, /file_sha256/)
  assert.match(
    migration,
    /revoke all on function public\.payroll_register_payslip_version[\s\S]*?from public, anon/
  )
})

test('server generator produces fixed A4 pages without a rate column', async () => {
  const bytes = await generatePayslipPdf(samplePreview(32))
  const document = await PDFDocument.load(bytes)
  const pages = document.getPages()

  assert.equal(PAYSLIP_PDF_TEMPLATE_VERSION, 'A4-V1')
  assert.ok(bytes.byteLength > 1000)
  assert.ok(pages.length >= 2)

  for (const page of pages) {
    assert.equal(Number(page.getWidth().toFixed(2)), 595.28)
    assert.equal(Number(page.getHeight().toFixed(2)), 841.89)
  }

  const source = await readFile(
    'functions/_shared/payslip-pdf.js',
    'utf8'
  )
  assert.doesNotMatch(source, /item\.unit_rate/)
  assert.doesNotMatch(source, /rates_used/)
  assert.doesNotMatch(source, /correction_notes/)
  assert.doesNotMatch(source, /adjustment_reason/)
})

test('server endpoints upload privately and return only temporary signed downloads', async () => {
  const [generate, signedUrl, service, middleware] = await Promise.all([
    readFile('functions/api/payslips/generate.js', 'utf8'),
    readFile('functions/api/payslips/signed-url.js', 'utf8'),
    readFile('functions/_shared/payslip-service.js', 'utf8'),
    readFile('functions/_middleware.js', 'utf8')
  ])

  assert.match(generate, /requireWorkforcePermission\(context, 'export_payslips'\)/)
  assert.match(generate, /generatePayslipPdf\(employeeSafePreview\)/)
  assert.match(generate, /rates_used: \[\]/)
  assert.match(generate, /unit_rate: null/)
  assert.match(generate, /crypto\.subtle\.digest\('SHA-256'/)
  assert.match(generate, /upsert: false/)
  assert.match(generate, /removeUpload/)
  assert.match(signedUrl, /loadAuthorizedPayslipPreview/)
  assert.match(signedUrl, /createSignedUrl/)
  assert.match(service, /PAYSLIP_SIGNED_URL_SECONDS = 120/)
  assert.doesNotMatch(`${generate}\n${signedUrl}\n${service}`, /getPublicUrl/)
  assert.doesNotMatch(`${generate}\n${signedUrl}\n${service}`, /console\./)
  assert.match(
    middleware,
    /'\/api\/payslips\/generate'[\s\S]*?permission: 'export_payslips'/
  )
})

test('payslip preview exposes generation and signed-download controls without logging payroll data', async () => {
  const [html, script] = await Promise.all([
    readFile('payslip-preview.html', 'utf8'),
    readFile('scripts/payslip-preview.js', 'utf8')
  ])

  assert.match(html, /id="generatePayslipPdfButton"/)
  assert.match(html, /id="downloadPayslipPdfButton"/)
  assert.match(html, /id="payslipPdfStatus"/)
  assert.match(script, /hasWorkforcePermission\([\s\S]*?'export_payslips'/)
  assert.match(script, /\.\/api\/payslips\/generate/)
  assert.match(script, /\.\/api\/payslips\/signed-url/)
  assert.match(script, /Authorization: `Bearer \$\{state\.accessToken\}`/)
  assert.match(script, /window\.location\.assign\(result\.signedUrl\)/)
  assert.doesNotMatch(script, /console\./)
})

test('Step 12 verification checks storage privacy, grants, immutability, and file integrity', async () => {
  const verification = await readFile(
    'supabase/verification/payroll_payslip_pdfs_check.sql',
    'utf8'
  )

  assert.match(verification, /bucket_is_private_should_be_true/)
  assert.match(verification, /browser_can_read_versions_should_be_false/)
  assert.match(verification, /anon_can_register_should_be_false/)
  assert.match(verification, /payslip_versions_immutable/)
  assert.match(verification, /invalid_version_count_should_be_zero/)
  assert.match(verification, /missing_storage_object_count_should_be_zero/)
  assert.match(verification, /public_storage_policy_count_should_be_zero/)
})
