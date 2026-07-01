import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('Step 4 backfill requires all four canonical dimensions', async () => {
  const source = await read(
    'functions/api/backfill-zendesk-ticket-dimensions.js'
  )

  assert.match(
    source,
    /const REQUIRED_FIELDS = \['app', 'platform', 'country', 'concern'\]/
  )
  assert.match(source, /concernFieldConfigured: Boolean\(fieldMap\.concern\)/)
  assert.match(source, /app, platform, country, and concern/)
  assert.doesNotMatch(source, /driverFieldOptional/)
  assert.doesNotMatch(source, /driverFieldConfigured/)
})

test('Step 4 backfill reports explicit completion state', async () => {
  const source = await read(
    'functions/api/backfill-zendesk-ticket-dimensions.js'
  )

  assert.match(source, /endOfStream: Boolean\(page\?\.end_of_stream\)/)
  assert.match(source, /hasMore: !Boolean\(page\?\.end_of_stream\)/)
  assert.match(source, /requiredFieldsConfigured: REQUIRED_FIELDS\.length/)
})
