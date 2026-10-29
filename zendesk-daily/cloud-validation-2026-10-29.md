# Cloud recovery and validation — October 29, 2026

## Outcome

NO-GO for release or a live-parity claim. GO for continued isolated feature development after the collector defect below is addressed. No deployment, migration, Zendesk write, merge, protection change, or change to existing operational features was performed.

## Recovery and Production evidence

Work ran in Codex Cloud, Linux host `d3f2cf0720d5`, from `/workspace`. The Windows handoff directory `C:\w\slcs` and external CSV directories `G:\downloads\1021` and `G:\downloads\1022` are unavailable here; their contents were not independently inspected.

Remote `main` and the peeled annotated tag `production-baseline-2026-10-27` both resolve to `314c45aba88fdb5733a0c6bb784b03035f2d4004`. The annotated tag object itself is `bba3b0507758a44e29cd25e77081c8a16dd0a77e`. The initial checkout was clean on local branch `work` at the baseline. The existing published branch `feature/zendesk-daily-analytics` resolved to `e156344719457dd2615f0863b7f21fe85c3987d1` and was recovered into a separate worktree without rebuilding it.

The canonical Production URL recorded in the repository is `https://sl-cs-knowledge-base.pages.dev`. Its GET was blocked by the cloud proxy with `Tunnel connection failed: 403 Forbidden`. Thus the Git baseline is verified, but the current deployed Production version and functionality are NOT independently verified.

Implementation locations: `zendesk-daily/worker/src/` (Worker, analytics, OAuth, Zendesk client), `zendesk-daily/worker/migrations/0001_init.sql` (proposed isolated D1 schema), `zendesk-daily/dashboard/index.html`, `zendesk-daily/scripts/validate-readonly.mjs`, `tests/zendesk-daily.test.mjs`, and `tests/fixtures/zendesk-daily/`.

The implementation commit differs from the recovery baseline only in these Zendesk assets/tests and one package test command. Restricted operational modules are untouched. The Worker remains release-gated with placeholder D1 and Access configuration and an empty agent mapping. Branch protection was not changed or independently audited.

## Credentials and live validation

Managed runtime observations are current and report provider `cloud`, phase `running`, and both `ZENDESK_SUBDOMAIN` and `ZENDESK_ACCESS_TOKEN` ready. Both variables are nonempty in the process. `ZENDESK_EMAIL` and `ZENDESK_API_TOKEN` are absent. No values were printed or saved.

The existing validator already supports OAuth Bearer and standard API-token Basic authentication (`email/token:api_token`), with OAuth precedence. No authentication code change is necessary for this validation. The Worker OAuth refresh flow is separate and was not invoked.

The previous validator attempt at this same implementation commit stopped with `fetch failed`; this follow-up confirmed the blocker with an authenticated GET to the six-ID endpoint. The proxy rejected the CONNECT tunnel with 403 before a Zendesk HTTP response. This is not evidence that Zendesk rejected or accepted the credential.

The enforced restricted network policy has no custom allowed hosts; neither the configured Zendesk hostname nor the Production hostname is allowed. Stop dependent live validation until the supported cloud configuration permits those destinations. Do not bypass the proxy. Authentication success, token scopes, and API authorization remain unknown.

| Candidate label (not verified identity) | Candidate ID | Reporting scope | Live result |
|---|---|---|---|
| Amora / Amor | 7741200383892 | Yes | Unverified |
| Arby | 45529189471380 | Yes | Unverified |
| Arez | 7741235860628 | No | Unverified |
| Ford | 12697099220884 | Yes | Unverified |
| Gen | 34717107952788 | Yes | Unverified |
| Tommy Fang / AUTOMATED | 1905152069227 | Yes | Unverified |

Returned names, roles, and active status remain unavailable. Arez stays excluded from reporting. No mapping was finalized.

## Benchmark comparison and discrepancy classification

These figures are carried forward from `validation-review-2026-10-29.md`; the source CSVs and Explore report definition are unavailable here.

| PHT date | Recorded solved | Recorded one-touch | Recorded rate | Solved: Amor / Gen / Arby / Ford / Tommy | Live comparison |
|---|---:|---:|---:|---|---|
| 2026-10-21 | 799 | 418 | 52.315394% | 160 / 101 / 82 / 40 / 416 | Blocked |
| 2026-10-22 | 752 | 433 | 57.579787% | 183 / 80 / 76 / 36 / 377 | Blocked |

No API-minus-CSV delta can be calculated. Potential historical causes include later reopens, final solve changes, reassignment, current solved/closed status, account-timezone search indexing versus PHT boundaries, and Explore filters. The validator searches `status:solved`, so currently closed tickets can be omitted. Its one-touch denominator excludes API-channel tickets; confirm the benchmark uses the same definition before interpreting rates.

### Independently reproduced calculation/pipeline blocker

In `worker/src/index.js`, the collector destructures only the first row from `buildDailyRows`, sets `agentRow` from that row's solved count, and requires `agentRow && chosenAgent` to stage a ticket. The first row is always Amor. A synthetic ticket solved by Gen produces `firstRowSolved=0`, `genSolved=1`, and `wouldStage=false` under the current gate. This can drop tickets assigned to the other four agents. This is a source defect, separate from historical Zendesk changes; it does not establish any observed API/CSV discrepancy.

The direct analytics function also restricts public-reply counting to reporting agent IDs, whereas the validator and collector count public comments by all classified agents. Audit the consistency of these paths. Neither issue is repaired in this evidence-only recovery pass. Add a meaningful collector-level regression before a narrow fix; then verify all five agents stage correctly and that replies by agents outside the reporting scope affect one-touch consistently.

## Verification

- Direct `node tests/zendesk-daily.test.mjs`: 18 tests passed, zero failures (synthetic/mocked only). Covers both auth schemes, six candidate IDs, Arez exclusion, PHT bounds, pagination, retries, attribution, OAuth rotation, and D1 safeguards. It does not cover the collector staging defect.
- `npm run test:zendesk-daily`, `npm run test:build`, `npm run test:site`, and `npm run test:reporting` exited zero. The site's script names a missing `tests/user-management-resend-invite.test.mjs`, so that named coverage is unavailable.
- Direct existing regression files: build output 1/1; access/content 9/9; reporting operations access 3/3; dashboard sync 12/12; reporting system 9/9. Total 34 direct regression tests passed. Access/content emitted a nonfatal asynchronous diagnostic despite a zero exit and zero reported failures; do not treat this as full production certification.
- `git diff --check` passed for the implementation versus baseline.
- Targeted scan of all 17 changed files for private-key markers, GitHub/AWS credential patterns, and exact configured Zendesk-token matches found no matches. This is not a complete secret audit. Synthetic test credentials are present by design.

## Next step and effort

Keep the implementation on the dedicated feature branch and retain all release gates. First repair and test the collector staging gate and reply-count consistency. In parallel, use the supported cloud configuration workflow to permit the configured Zendesk hostname and canonical Production hostname. Then verify deployed Production, run the unchanged GET-only validator, confirm six identities/roles/active states manually, retain only the five approved reporting IDs, and reconcile results against the actual CSVs and Explore definitions.

This cloud follow-up took approximately 3 minutes of elapsed agent work, excluding the previous validation turn and any future configuration work; it remained within the three-hour cap. Estimated experienced-programmer effort for the recovery/review/validation-attempt work performed here: 1–2 hours. Estimated follow-up for the narrow collector fix, tests, and first live reconciliation once network and source CSV access are ready: 2–3 hours, excluding provisioning and approvals. These estimates do not represent time spent waiting or a completed implementation fix.
