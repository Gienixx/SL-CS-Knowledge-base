import {
  errorResponse,
  jsonResponse,
  latestPayslipVersion,
  loadAuthorizedPayslipPreview,
  loadPayslipAuthorization,
  PAYSLIP_SIGNED_URL_SECONDS,
  safeDownloadName,
  serviceClient
} from '../../_shared/payslip-service.js'
import { WorkforceAuthorizationError } from '../../_shared/workforce-auth.js'

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function onRequestPost(context) {
  try {
    const authorization = await loadPayslipAuthorization(context)
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
    const version = await latestPayslipVersion(
      authorization,
      payrollRecordId
    )

    if (!version) {
      throw new WorkforceAuthorizationError(
        'A PDF has not been generated for this payslip.',
        404
      )
    }

    const client = serviceClient(authorization)
    const { data, error } = await client.storage
      .from(version.storage_bucket)
      .createSignedUrl(
        version.storage_path,
        PAYSLIP_SIGNED_URL_SECONDS,
        {
          download: safeDownloadName(preview?.payslip_number)
        }
      )

    if (error || !data?.signedUrl) {
      throw new WorkforceAuthorizationError(
        'A temporary payslip download could not be created.',
        500
      )
    }

    return jsonResponse({
      signedUrl: data.signedUrl,
      expiresIn: PAYSLIP_SIGNED_URL_SECONDS,
      documentVersion: version.document_version,
      templateVersion: version.template_version,
      generatedAt: version.generated_at
    })
  } catch (error) {
    return errorResponse(
      error,
      'The temporary payslip download could not be created.'
    )
  }
}
