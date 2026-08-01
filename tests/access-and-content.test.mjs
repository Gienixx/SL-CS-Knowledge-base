import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  createLegacyWorkforceAccess,
  getWorkforceAccessType,
  hasWorkforcePermission,
  normalizeWorkforceAccess
} from '../shared/workforce-access.js'
import {
  onRequest as workforceMiddleware
} from '../functions/_middleware.js'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('retired User Management redirects to Employee Profiles', async () => {
  const [html, client] = await Promise.all([
    read('user-management.html'),
    read('scripts/supabaseClient.js')
  ])
  assert.match(html, /window\.location\.replace\('\.\/workforce\.html'\)/)
  assert.match(html, /http-equiv="refresh" content="0; url=\.\/workforce\.html"/)
  assert.doesNotMatch(html, /scripts\/user-management\.js|list-users|Read-only compatibility view/)
  assert.doesNotMatch(client, /admin\.html|admin-invite-protocol/)
})

test('knowledge-base authoring and published article rendering remain connected', async () => {
  const [knowledgeBase, kbScript, article, editor, management] = await Promise.all([
    read('KB.html'),
    read('scripts/kb.js'),
    read('article.html'),
    read('add-article.html'),
    read('scripts/article-management.js')
  ])
  assert.match(knowledgeBase, /scripts\/kb\.js/)
  assert.match(knowledgeBase, /id="kbSearch"/)
  assert.match(knowledgeBase, /id="kbList"/)
  assert.match(knowledgeBase, /id="kbDetail"/)
  assert.match(knowledgeBase, /id="backToTop"/)
  assert.match(knowledgeBase, /class="layout"/)
  assert.match(knowledgeBase, /grid-template-columns:260px minmax\(0,1fr\)/)
  assert.match(knowledgeBase, /\.header\{[\s\S]*max-width:1440px/)
  assert.match(knowledgeBase, /\.layout\{[\s\S]*max-width:1440px/)
  assert.match(knowledgeBase, /\.back-to-top\{[\s\S]*position:fixed/)
  assert.match(knowledgeBase, /\.back-to-top\.visible/)
  assert.match(knowledgeBase, /class="back-to-top-icon" aria-hidden="true">↑<\/span>/)
  assert.match(knowledgeBase, /\.back-to-top\.visible:hover\{[\s\S]*background:var\(--logo-bg\)/)
  assert.doesNotMatch(knowledgeBase, /On this page|Related articles/)
  assert.match(article, /window\.location\.replace\(target\.href\)/)
  assert.match(article, /searchParams\.set\('article', articleId\)/)
  assert.doesNotMatch(article, /scripts\/article\.js/)
  assert.match(knowledgeBase, /scripts\/kb\.js\?v=16/)
  assert.match(kbScript, /getRequestedArticleRoute\(\)/)
  assert.match(kbScript, /\.get\('article'\)/)
  assert.match(kbScript, /\{ articleTitle: item\.title \}/)
  assert.match(kbScript, /findArticleByRouteValue/)
  assert.match(kbScript, /createCopyArticleLinkButton/)
  assert.match(kbScript, /addArticleSectionAnchors/)
  assert.match(kbScript, /scrollToRequestedArticleSection/)
  assert.match(management, /getArticleHref\(article\)/)
  assert.match(kbScript, /parseArticleContent\(item\.content\)/)
  assert.match(kbScript, /renderArticleUnit\(unit\)/)
  assert.match(kbScript, /body\.className = item\.category === 'others' \? 'detail-body' : 'article-body'/)
  assert.match(kbScript, /function scrollToSelectedItem\(\)/)
  assert.match(kbScript, /window\.scrollTo\(\{ top: 0, behavior \}\)/)
  assert.match(kbScript, /renderDetail\(item\)\s*scrollToSelectedItem\(\)/)
  assert.match(knowledgeBase, /\.article-body h2/)
  assert.match(knowledgeBase, /\.article-cover\{/)
  assert.match(knowledgeBase, /id="kbDetail" class="detail"/)
  assert.match(editor, /scripts\/add-article\.js/)
})

test('authentication and first-login pages remain connected', async () => {
  const [login, loginScript, password, firstLoginPolicy] = await Promise.all([
    read('login.html'), read('scripts/login.js'), read('change-password.html'), read('scripts/first-login-policy.js')
  ])
  assert.match(login, /id="loginForm"/)
  assert.match(loginScript, /signInWithPassword/)
  assert.match(password, /scripts\/change-password\.js/)
  assert.match(firstLoginPolicy, /requiresFirstLoginPasswordChange/)
})

test('password invite page GET bypasses the admin password API middleware', async () => {
  let nextCalls = 0

  const response = await workforceMiddleware({
    request: new Request(
      'https://support.example/change-password?invite=1',
      { method: 'GET' }
    ),
    next: async () => {
      nextCalls += 1
      return new Response('password page')
    }
  })

  assert.equal(nextCalls, 1)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'password page')
})

test('password administration POST remains protected', async () => {
  let nextCalls = 0

  const response = await workforceMiddleware({
    request: new Request(
      'https://support.example/change-password',
      { method: 'POST' }
    ),
    next: async () => {
      nextCalls += 1
      return new Response('unexpected')
    }
  })

  assert.equal(nextCalls, 0)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), {
    error: 'Authentication required.'
  })
})

test('dashboard and protected endpoints use the central workforce permission service', async () => {
  const [
    dashboard,
    browserService,
    middleware,
    functionHelper,
    migration,
    correctiveMigration
  ] = await Promise.all([
    read('scripts/dashboard.js'),
    read('scripts/workforce-permissions.js'),
    read('functions/_middleware.js'),
    read('functions/_shared/workforce-auth.js'),
    read('supabase/migrations-legacy/2026070605_workforce_permission_service.sql'),
    read('supabase/migrations-legacy/2026070606_workforce_rpc_permissions.sql')
  ])

  assert.match(dashboard, /loadCurrentWorkforceAccess/)
  assert.match(dashboard, /hasWorkforcePermission/)
  assert.doesNotMatch(dashboard, /\.from\(['"]login['"]\)/)
  assert.match(browserService, /workforce_get_current_access/)
  assert.match(functionHelper, /workforce_get_current_access/)
  assert.match(middleware, /manage_employees/)
  assert.match(middleware, /methods:\s*\['POST'\]/)
  assert.match(middleware, /requireAdmin:\s*true/)
  assert.match(migration, /security definer/i)
  assert.match(migration, /revoke execute[^;]+from anon/is)
  assert.match(migration, /grant execute[^;]+authenticated/is)
  assert.match(correctiveMigration, /revoke execute[^;]+from anon/is)
  assert.match(correctiveMigration, /revoke all[^;]+from public/is)
  assert.match(correctiveMigration, /grant execute[^;]+authenticated/is)
})

test('the three canonical access types are mapped consistently', () => {
  assert.equal(getWorkforceAccessType({
    is_admin: true,
    is_agent: true,
    permissions: {}
  }), 'admin_agent')

  assert.equal(getWorkforceAccessType({
    is_admin: true,
    is_agent: false,
    permissions: {}
  }), 'admin')

  assert.equal(getWorkforceAccessType({
    is_admin: false,
    is_agent: true,
    permissions: { edit_articles: true }
  }), 'regular_agent')

  assert.equal(getWorkforceAccessType({
    is_admin: false,
    is_agent: true,
    permissions: {}
  }), 'regular_agent')
})

test('administrator scope does not silently grant a revoked permission', () => {
  const access = normalizeWorkforceAccess({
    user_id: 'admin-user',
    is_active: true,
    base_role: 'admin',
    is_admin: true,
    is_agent: false,
    permissions: {
      manage_employees: false,
      edit_articles: true
    }
  })

  assert.equal(access.is_admin, true)
  assert.equal(hasWorkforcePermission(access, 'manage_employees'), false)
  assert.equal(hasWorkforcePermission(access, 'edit_articles'), true)
})

test('legacy compatibility maps current admin and editor flags without payroll access', () => {
  const access = createLegacyWorkforceAccess({
    name: 'Legacy Admin',
    email: 'admin@example.com',
    is_admin: true,
    can_edit_articles: true
  }, {
    user: {
      id: 'legacy-user',
      email: 'admin@example.com'
    }
  })

  assert.equal(access.access_type, 'admin_agent')
  assert.equal(hasWorkforcePermission(access, 'manage_employees'), true)
  assert.equal(hasWorkforcePermission(access, 'edit_articles'), true)
  assert.equal(hasWorkforcePermission(access, 'manage_payroll'), false)
})
