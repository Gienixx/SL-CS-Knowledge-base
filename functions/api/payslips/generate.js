import {
  requireWorkforcePermission,
  WorkforceAuthorizationError
} from '../../_shared/workforce-auth.js'
import {
  generatePayslipPdf,
  PAYSLIP_PDF_TEMPLATE_VERSION
} from '../../_shared/payslip-pdf.js'
import {
  errorResponse,
  jsonResponse,
  loadAuthorizedPayslipPreview,
  PAYSLIP_STORAGE_BUCKET,
  registerPayslipVersion,
  serviceClient
} from '../../_shared/payslip-service.js'

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function toHex(bytes) {
  return [...new Uint8Array(bytes)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')
}

async function removeUpload(client, storagePath) {
  try {
    await client.storage
      .from(PAYSLIP_STORAGE_BUCKET)
      .remove([storagePath])
  } catch {
    // The database will not reference an upload that failed registration.
  }
}

export async function onRequestPost(context) {
  let authorization
  let storagePath = ''
  let adminClient

  try {
    authorization = context.data?.workforceAuthorization ||
      await requireWorkforcePermission(context, 'export_payslips')

    const body = await context.request.json().catch(() => null)
    const payrollRecordId = String(body?.payrollRecordId || '').trim()

    if (!uuidPattern.test(payrollRecordId)) {
      throw new WorkforceAuthorizationError(
        'A valid payroll record is required.',
        400
      )
    }

    const preview = await loadAuthorizedPayslipPreview(
      authorization,
      payrollRecordId
    )

    const employeeSafePreview = {
      ...preview,
      can_view_rates: false,
      rates_used: [],
      earnings: Array.isArray(preview?.earnings)
        ? preview.earnings.map(item => ({ ...item, unit_rate: null }))
        : [],
      deductions: Array.isArray(preview?.deductions)
        ? preview.deductions.map(item => ({ ...item, unit_rate: null }))
        : []
    }
    const pdfBytes = await generatePayslipPdf(employeeSafePreview)
    const digest = await crypto.subtle.digest('SHA-256', pdfBytes)
    const fileSha256 = toHex(digest)
    const periodId = String(preview?.period?.payroll_period_id || '')

    if (!uuidPattern.test(periodId)) {
      throw new WorkforceAuthorizationError(
        'The finalized payroll period is invalid.',
        500
      )
    }

    storagePath =
      `${periodId}/${payrollRecordId}/${crypto.randomUUID()}.pdf`
    adminClient = serviceClient(authorization)

    const { error: uploadError } = await adminClient.storage
      .from(PAYSLIP_STORAGE_BUCKET)
      .upload(storagePath, pdfBytes, {
        contentType: 'application/pdf',
        cacheControl: '0',
        upsert: false
      })

    if (uploadError) {
      throw new WorkforceAuthorizationError(
        'The private payslip PDF could not be stored.',
        500
      )
    }

    let registration
    try {
      registration = await registerPayslipVersion(
        authorization,
        {
          payrollRecordId,
          storagePath,
          fileSha256,
          fileSizeBytes: pdfBytes.byteLength,
          templateVersion: PAYSLIP_PDF_TEMPLATE_VERSION
        }
      )
    } catch (error) {
      await removeUpload(adminClient, storagePath)
      throw error
    }

    return jsonResponse({
      generated: true,
      payslipNumber: registration.payslip_number,
      documentVersion: registration.document_version,
      templateVersion: registration.template_version,
      generatedAt: registration.generated_at
    })
  } catch (error) {
    if (adminClient && storagePath) {
      await removeUpload(adminClient, storagePath)
    }
    return errorResponse(error, 'The payslip PDF could not be generated.')
  }
}
