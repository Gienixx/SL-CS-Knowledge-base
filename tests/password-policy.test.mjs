import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluatePassword,
  passwordsMatch
} from '../scripts/password-policy.js'

test('password policy reports empty, weak, partial, and strong states', () => {
  assert.deepEqual(evaluatePassword(''), {
    checks: {
      hasLength: false,
      hasMixedCase: false,
      hasNumber: false
    },
    score: 0,
    label: 'Enter a password',
    valid: false
  })

  assert.equal(evaluatePassword('password').label, 'Weak')
  assert.equal(evaluatePassword('Password').label, 'Good')
  assert.equal(evaluatePassword('Password1').label, 'Strong')
  assert.equal(evaluatePassword('Password1').valid, true)
})

test('password policy requires every displayed requirement', () => {
  assert.equal(evaluatePassword('Short1').valid, false)
  assert.equal(evaluatePassword('lowercase1').valid, false)
  assert.equal(evaluatePassword('NoNumberHere').valid, false)
})

test('password confirmation requires a non-empty exact match', () => {
  assert.equal(passwordsMatch('Password1', ''), false)
  assert.equal(passwordsMatch('Password1', 'Password2'), false)
  assert.equal(passwordsMatch('Password1', 'Password1'), true)
})
