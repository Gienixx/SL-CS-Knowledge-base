import { createClient } from '@supabase/supabase-js'
import {
  loadWorkforceAuthorization,
  WorkforceAuthorizationError
} from './workforce-auth.js'

export const PAYSLIP_STORAGE_BUCKET = 'payroll-payslips'
export const PAYSLIP_SIGNED_URL_SECONDS = 120

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  })
}

function clientOptions(headers = {}) {
  return {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    },
    global: { headers }
  }
}

export function serviceClient(authorization) {
  return createClient(
    authorization.supabaseUrl,
    authorization.serviceRoleKey,
    clientOptions({
      Authorization: `Bearer ${authorization.serviceRoleKey}`
    })
  )
}

function responseMessage(data, fallback) {
  if (data && typeof data === 'object') {
    return data.message || data.error || fallback
  }
  return typeof data === 'string' && data.trim() ? data : fallback
}

async function parseResponse(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function loadPayslipAuthorization(context) {
  return loadWorkforceAuthorization(context)
}

export async function loadAuthorizedPayslipPreview(
  authorization,
  payrollRecordId
) {
  const response = await fetch(
    `${authorization.supabaseUrl}/rest/v1/rpc/payroll_get_payslip_preview`,
    {
      method: 'POST',
      headers: {
        apikey: authorization.anonKey,
        Authorization: `Bearer ${authorization.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_payroll_record_id: payrollRecordId
      })
    }
  )
  const data = await parseResponse(response)

  if (!response.ok) {
    throw new WorkforceAuthorizationError(
      responseMessage(data, 'The finalized payslip is unavailable.'),
      response.status >= 400 && response.status < 600
        ? response.status
        : 500
    )
  }
  return data
}

export async function registerPayslipVersion(
  authorization,
  {
    payrollRecordId,
    storagePath,
    fileSha256,
    fileSizeBytes,
    templateVersion
  }
) {
  const response = await fetch(
    `${authorization.supabaseUrl}/rest/v1/rpc/payroll_register_payslip_version`,
    {
      method: 'POST',
      headers: {
        apikey: authorization.anonKey,
        Authorization: `Bearer ${authorization.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_payroll_record_id: payrollRecordId,
        p_storage_bucket: PAYSLIP_STORAGE_BUCKET,
        p_storage_path: storagePath,
        p_file_sha256: fileSha256,
        p_file_size_bytes: fileSizeBytes,
        p_template_version: templateVersion
      })
    }
  )
  const data = await parseResponse(response)

  if (!response.ok) {
    throw new WorkforceAuthorizationError(
      responseMessage(data, 'The payslip PDF could not be registered.'),
      response.status >= 400 && response.status < 600
        ? response.status
        : 500
    )
  }
  return data
}

export async function latestPayslipVersion(
  authorization,
  payrollRecordId
) {
  const client = serviceClient(authorization)
  const { data, error } = await client
    .from('payslip_versions')
    .select(
      'document_version, template_version, storage_bucket, storage_path, generated_at'
    )
    .eq('payroll_record_id', payrollRecordId)
    .order('document_version', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new WorkforceAuthorizationError(
      'The stored payslip PDF could not be loaded.',
      500
    )
  }
  return data || null
}

export function safeDownloadName(payslipNumber) {
  const identifier = String(payslipNumber || 'payslip')
    .toUpperCase()
    .replace(/[^A-Z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)

  return `${identifier || 'PAYSLIP'}.pdf`
}

export function errorResponse(error, fallback) {
  const status = error instanceof WorkforceAuthorizationError
    ? error.status
    : 500

  return jsonResponse(
    {
      error: status === 500
        ? fallback
        : error.message
    },
    status
  )
}
