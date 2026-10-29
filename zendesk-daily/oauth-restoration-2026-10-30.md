# OAuth restoration — October 30, 2026

Base: `bb577f1bbff9829e9c227f47cd15b3a38f23cbbc`, published
`feature/zendesk-daily-analytics`. No search for the unavailable OAuth commit.

The Cloud checkout initially contained main only. The GitHub connector supplied
the published branch files; all restored file blob SHAs and the complete baseline
Git tree (`0d4b21cfc43eba63f4f2c37756942f529c6f66e1`) were verified before edits.
Implementation and tests ran in an isolated Codex Cloud workspace.

Restored read-scoped Client Credentials grants, in-memory tokens with expiration
renewal and shared concurrent acquisition, one controlled renewal after a 401,
and precedence over a configured legacy access token. Collector and validator
reads use the managed auth object. Existing refresh-token rotation is preserved
under `getRefreshAccessToken`. Analytics and attribution logic are unchanged.
`verify-auth.mjs` reads the authenticated identity and all six candidate IDs,
checks active agent/admin status, and retains Arez's reporting exclusion.

Validation:

- 36 existing Zendesk tests plus 14 focused OAuth tests pass (50 total).
- Full repository test files executed individually: 936 tests, 935 pass,
  zero failures, one existing PostgreSQL concurrency integration test skipped.
- Focused tests cover grant request/scope, credential precedence, cache,
  expiration, concurrent acquisition, single 401 renewal, failed renewal,
  authentication failures, malformed responses, secret protection, origin/redirect
  restrictions, and successful/incomplete six-candidate verification.
- `npm run test:zendesk-daily` passes; this runtime summarizes test files, so
  direct execution of both files separately confirmed all 50 individual tests.
- `git diff --check` passes.

Cloud network observations were current and policy enforced. Zendesk's configured
host is allowed and all four Zendesk runtime variables are ready. Nevertheless,
Git fetch and credential-free Zendesk HEAD both fail immediately with inability to
connect to the inherited proxy on port 8080. No diagnostic history was available.
Live OAuth and live identity verification were therefore **not attempted**. No
credential was sent and no real Zendesk authentication result is claimed.
GitHub connector publication is used because Cloud Git transport is unavailable.

GO for review of the isolated implementation and offline tests. NO-GO for live
operational acceptance until Cloud proxy connectivity is restored and the
verification script succeeds against Zendesk. No deployment, merge, migration,
ticket write, or operational-module change was performed.

Experienced-programmer estimate: 3–5 hours including implementation, focused
coverage, regressions, and publication; excludes infrastructure repair and live
Zendesk permission troubleshooting.
