const PAYPAL_PRODUCTION_API = 'https://api-m.paypal.com'
const ECB_USD_PHP_REFERENCE_API =
  'https://api.frankfurter.dev/v2/rate/USD/PHP?providers=ECB'
const PAYPAL_PAYOUT_SPREAD_PERCENT = 4

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

function roundRate(value) {
  return Math.round(value * 1_000_000) / 1_000_000
}

export async function fetchEstimatedPayPalUsdPhpQuote(
  fetchImpl = fetch,
  {
    configured = false,
    unavailableStatus = 503,
    unavailableError = 'The PayPal exchange rate is temporarily unavailable.'
  } = {}
) {
  try {
    const response = await fetchImpl(ECB_USD_PHP_REFERENCE_API, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    })
    const data = await parseJson(response)
    const marketRate = parsePositiveRate(data?.rate)
    const referenceDate = String(data?.date || '').trim()
    const validPair = data?.base === 'USD' && data?.quote === 'PHP'

    if (!response.ok || !marketRate || !referenceDate || !validPair) {
      throw new Error('Invalid ECB reference response.')
    }

    const exchangeRate = roundRate(
      marketRate * (1 - PAYPAL_PAYOUT_SPREAD_PERCENT / 100)
    )

    return {
      configured,
      status: 200,
      data: {
        configured,
        source: 'Estimated PayPal conversion',
        rateType: 'paypal_estimate',
        baseCurrency: 'USD',
        quoteCurrency: 'PHP',
        exchangeRate,
        marketRate,
        spreadPercent: PAYPAL_PAYOUT_SPREAD_PERCENT,
        spreadUseCase:
          'PayPal payment or Payouts conversion into a different currency',
        referenceSource: 'European Central Bank',
        referenceProvider: 'Frankfurter',
        referenceDate,
        fetchedAt: new Date().toISOString(),
        expiresAt: null,
        refreshesAt: null
      }
    }
  } catch {
    return {
      configured,
      status: unavailableStatus,
      data: {
        configured,
        source: 'PayPal',
        baseCurrency: 'USD',
        quoteCurrency: 'PHP',
        error: unavailableError
      }
    }
  }
}

export async function fetchPayPalUsdPhpQuote(environment, fetchImpl = fetch) {
  if (!paypalFxConfigured(environment)) {
    return fetchEstimatedPayPalUsdPhpQuote(fetchImpl, {
      configured: false,
      unavailableStatus: 503,
      unavailableError:
        'PayPal FX credentials are not configured and the market estimate is unavailable.'
    })
  }

  const apiBase = normalizedApiBase(environment.PAYPAL_API_BASE_URL)
  const credentials = btoa(
    `${environment.PAYPAL_CLIENT_ID}:${environment.PAYPAL_CLIENT_SECRET}`
  )

  let tokenResponse
  try {
    tokenResponse = await fetchImpl(`${apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    })
  } catch {
    return fetchEstimatedPayPalUsdPhpQuote(fetchImpl, {
      configured: true,
      unavailableStatus: 502,
      unavailableError:
        'PayPal authentication and the market estimate are temporarily unavailable.'
    })
  }
  const tokenData = await parseJson(tokenResponse)
  const accessToken = String(tokenData?.access_token || '').trim()

  if (!tokenResponse.ok || !accessToken) {
    return fetchEstimatedPayPalUsdPhpQuote(fetchImpl, {
      configured: true,
      unavailableStatus: 502,
      unavailableError:
        'PayPal authentication failed and the market estimate is unavailable.'
    })
  }

  let quoteResponse
  try {
    quoteResponse = await fetchImpl(
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
  } catch {
    return fetchEstimatedPayPalUsdPhpQuote(fetchImpl, {
      configured: true,
      unavailableStatus: 502,
      unavailableError:
        'PayPal and the market estimate are temporarily unavailable.'
    })
  }
  const quoteData = await parseJson(quoteResponse)
  const quote = quoteData?.exchange_rate_quotes?.[0] || null
  const exchangeRate = parsePositiveRate(quote?.exchange_rate)

  if (!quoteResponse.ok || !exchangeRate) {
    return fetchEstimatedPayPalUsdPhpQuote(fetchImpl, {
      configured: true,
      unavailableStatus: quoteResponse.status === 403 ? 503 : 502,
      unavailableError: quoteResponse.status === 403
        ? 'This PayPal application is not enabled for live FX quotes and the market estimate is unavailable.'
        : 'PayPal did not return a valid quote and the market estimate is unavailable.'
    })
  }

  return {
    configured: true,
    status: 200,
    data: {
      configured: true,
      source: 'PayPal',
      rateType: 'paypal_live',
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
