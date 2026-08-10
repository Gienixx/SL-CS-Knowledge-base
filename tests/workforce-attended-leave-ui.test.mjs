import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('attended leave selection calls the separate-sequence RPC with the source schedule and refreshes', async () => {
  const client = await read('scripts/workforce-schedules.js')
  assert.match(client, /const rpcArgs = \{[\s\S]*p_schedule_id: scheduleId[\s\S]*p_schedule_type: otherType[\s\S]*p_subtype: specialSubtype/)
  assert.match(client, /supabase\.rpc\('workforce_admin_save_nonworking_schedule', \{[\s\S]*\.\.\.rpcArgs/)
  assert.match(client, /lastSavedSchedule = savedSchedule/)
  assert.match(client, /await loadScheduleData\(\)/)
  assert.match(client, /Attendance-linked work schedule preserved; leave saved as a separate sequence/)
})
