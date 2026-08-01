import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findArticleByRouteValue,
  getArticleHref,
  getArticleRouteValue,
  getArticleSectionIds
} from '../scripts/article-route.js'

const articles = [
  { id: '16', title: 'Sign Up' },
  { id: '22', title: "Customer's First Cashout" },
  { id: '31', title: 'Café Support & Escalations' }
]

test('article routes use readable title slugs', () => {
  assert.equal(getArticleRouteValue('Sign Up'), 'sign-up')
  assert.equal(
    getArticleRouteValue("Customer's First Cashout"),
    'customers-first-cashout'
  )
  assert.equal(
    getArticleRouteValue('Café Support & Escalations'),
    'cafe-support-escalations'
  )
  assert.equal(
    getArticleHref(articles[0]),
    './KB.html?article=sign-up'
  )
})

test('article routing resolves title slugs and legacy numeric links', () => {
  assert.equal(
    findArticleByRouteValue(articles, 'sign-up'),
    articles[0]
  )
  assert.equal(
    findArticleByRouteValue(articles, '16'),
    articles[0]
  )
  assert.equal(
    findArticleByRouteValue(articles, 'missing-article'),
    null
  )
})

test('article section IDs are readable and duplicate safe', () => {
  assert.deepEqual(
    getArticleSectionIds([
      'Overview',
      'Mobile App Sign Up',
      'Overview',
      'Café Support'
    ]),
    [
      'overview',
      'mobile-app-sign-up',
      'overview-2',
      'cafe-support'
    ]
  )
})
