import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  fetchEstimatedPayPalUsdPhpQuote,
  fetchPayPalUsdPhpQuote,
  paypalFxConfigured
} from '../functions/api/paypal-exchange-rate.js'

const middlewareUrl = new URL('../functions/_middleware.js', import.meta.url)

test('missing PayPal access falls back to an ECB rate with the published spread', async () => {
  const requests = []
  const result = await fetchPayPalUsdPhpQuote({}, async (url, options) => {
    requests.push({ url, options })
    return new Response(JSON.stringify({
      date: '2026-07-22',
      base: 'USD',
      quote: 'PHP',
      rate: 61.763
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  })

  assert.equal(paypalFxConfigured({}), false)
  assert.equal(requests.length, 1)
  assert.equal(
    requests[0].url,
    'https://api.frankfurter.dev/v2/rate/USD/PHP?providers=ECB'
  )
  assert.equal(result.status, 200)
  assert.equal(result.data.configured, false)
  assert.equal(result.data.rateType, 'paypal_estimate')
  assert.equal(result.data.baseCurrency, 'USD')
  assert.equal(result.data.quoteCurrency, 'PHP')
  assert.equal(result.data.marketRate, 61.763)
  assert.equal(result.data.spreadPercent, 4)
  assert.equal(result.data.exchangeRate, 59.29248)
  assert.equal(result.data.referenceSource, 'European Central Bank')
})

test('PayPal FX integration requests and returns a live USD to PHP quote', async () => {
  const requests = []
  const fetchMock = async (url, options) => {
    requests.push({ url, options })

    if (url.endsWith('/v1/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'server-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({
      exchange_rate_quotes: [{
        exchange_rate: '58.123456',
        expiry_time: '2026-07-23T09:00:00Z',
        rate_refresh_time: '2026-07-23T08:55:00Z'
      }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const result = await fetchPayPalUsdPhpQuote({
    PAYPAL_CLIENT_ID: 'client-id',
    PAYPAL_CLIENT_SECRET: 'client-secret'
  }, fetchMock)

  assert.equal(result.status, 200)
  assert.equal(result.data.exchangeRate, 58.123456)
  assert.equal(result.data.rateType, 'paypal_live')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://api-m.paypal.com/v1/oauth2/token')
  assert.match(requests[0].options.headers.Authorization, /^Basic /)
  assert.equal(requests[0].options.body, 'grant_type=client_credentials')
  assert.equal(
    requests[1].url,
    'https://api-m.paypal.com/v2/pricing/quote-exchange-rates'
  )
  assert.equal(requests[1].options.headers.Authorization, 'Bearer server-token')
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    quote_items: [{
      base_currency: 'USD',
      quote_currency: 'PHP'
    }]
  })
})

test('PayPal FX eligibility failures fall back without leaking details', async () => {
  const responses = [
    new Response(JSON.stringify({ access_token: 'server-token' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }),
    new Response(JSON.stringify({ name: 'NOT_AUTHORIZED' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    }),
    new Response(JSON.stringify({
      date: '2026-07-22',
      base: 'USD',
      quote: 'PHP',
      rate: 61.763
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  ]

  const result = await fetchPayPalUsdPhpQuote({
    PAYPAL_CLIENT_ID: 'client-id',
    PAYPAL_CLIENT_SECRET: 'client-secret'
  }, async () => responses.shift())

  assert.equal(result.status, 200)
  assert.equal(result.data.configured, true)
  assert.equal(result.data.rateType, 'paypal_estimate')
  assert.equal(result.data.exchangeRate, 59.29248)
  assert.doesNotMatch(JSON.stringify(result.data), /client-id|client-secret|server-token/)
})

test('the fallback fails closed when the official reference is unavailable', async () => {
  const result = await fetchEstimatedPayPalUsdPhpQuote(
    async () => new Response(JSON.stringify({ rate: 'invalid' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    }),
    {
      configured: false,
      unavailableStatus: 503,
      unavailableError: 'No reliable conversion is available.'
    }
  )

  assert.equal(result.status, 503)
  assert.equal(result.data.exchangeRate, undefined)
  assert.equal(result.data.error, 'No reliable conversion is available.')
})

test('PayPal FX endpoint requires the payroll rate permission', async () => {
  const middleware = await readFile(middlewareUrl, 'utf8')

  assert.match(
    middleware,
    /'\/api\/paypal-exchange-rate': \{[\s\S]*?methods: \['GET'\][\s\S]*?permission: 'manage_agent_rates'/
  )
})
