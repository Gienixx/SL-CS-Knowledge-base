const PAYPAL_PRODUCTION_API = 'https://api-m.paypal.com'

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

function normalizedApiBase(value) {
  const configured = String(value || '').trim()
  const base = configured || PAYPAL_PRODUCTION_API
  return base.endsWith('/') ? base.slice(0, -1) : base
}

function parsePositiveRate(value) {
  const rate = Number(value)
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

async function parseJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export function paypalFxConfigured(environment = {}) {
  return Boolean(
    String(environment.PAYPAL_CLIENT_ID || '').trim() &&
    String(environment.PAYPAL_CLIENT_SECRET || '').trim()
  )
}

export async function fetchPayPalUsdPhpQuote(environment, fetchImpl = fetch) {
  if (!paypalFxConfigured(environment)) {
    return {
      configured: false,
      status: 503,
      data: {
        configured: false,
        source: 'PayPal',
        baseCurrency: 'USD',
        quoteCurrency: 'PHP',
        error: 'PayPal FX credentials are not configured.'
      }
    }
  }

  const apiBase = normalizedApiBase(environment.PAYPAL_API_BASE_URL)
  const credentials = btoa(
    `${environment.PAYPAL_CLIENT_ID}:${environment.PAYPAL_CLIENT_SECRET}`
  )

  const tokenResponse = await fetchImpl(`${apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  })
  const tokenData = await parseJson(tokenResponse)
  const accessToken = String(tokenData?.access_token || '').trim()

  if (!tokenResponse.ok || !accessToken) {
    return {
      configured: true,
      status: 502,
      data: {
        configured: true,
        source: 'PayPal',
        baseCurrency: 'USD',
        quoteCurrency: 'PHP',
        error: 'PayPal authentication failed.'
      }
    }
  }

  const quoteResponse = await fetchImpl(
    `${apiBase}/v2/pricing/quote-exchange-rates`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        quote_items: [{
          base_currency: 'USD',
          quote_currency: 'PHP'
        }]
      })
    }
  )
  const quoteData = await parseJson(quoteResponse)
  const quote = quoteData?.exchange_rate_quotes?.[0] || null
  const exchangeRate = parsePositiveRate(quote?.exchange_rate)

  if (!quoteResponse.ok || !exchangeRate) {
    return {
      configured: true,
      status: quoteResponse.status === 403 ? 503 : 502,
      data: {
        configured: true,
        source: 'PayPal',
        baseCurrency: 'USD',
        quoteCurrency: 'PHP',
        error: quoteResponse.status === 403
          ? 'This PayPal application is not enabled for live FX quotes.'
          : 'PayPal did not return a valid USD to PHP quote.'
      }
    }
  }

  return {
    configured: true,
    status: 200,
    data: {
      configured: true,
      source: 'PayPal',
      baseCurrency: 'USD',
      quoteCurrency: 'PHP',
      exchangeRate,
      fetchedAt: new Date().toISOString(),
      expiresAt: quote.expiry_time || null,
      refreshesAt: quote.rate_refresh_time || null
    }
  }
}

export async function onRequestGet(context) {
  try {
    const result = await fetchPayPalUsdPhpQuote(context.env)
    return jsonResponse(result.data, result.status)
  } catch {
    console.error('PayPal exchange-rate request failed.')
    return jsonResponse(
      {
        configured: paypalFxConfigured(context.env),
        source: 'PayPal',
        baseCurrency: 'USD',
        quoteCurrency: 'PHP',
        error: 'The PayPal exchange rate is temporarily unavailable.'
      },
      502
    )
  }
}
