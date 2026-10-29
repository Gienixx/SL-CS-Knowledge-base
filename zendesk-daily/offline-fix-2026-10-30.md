# Zendesk collector offline fix — October 30, 2026

Production release status: **NO-GO**. This change supersedes the unresolved collector findings in `cloud-validation-2026-10-29.md`; it does not establish live API or Explore parity.

## Root cause and targeted repair

The collector destructured the first `buildDailyRows` result, which always represents Amor, and required that row to have a solved ticket before staging any ticket. Tickets belonging to the other four reporting agents therefore failed the gate.

The collector now resolves the ticket's solve-time attribution directly and stages it only when that ID matches an approved reporting agent. The aggregate row order no longer controls eligibility. PHT solved-time filtering uses the same finite-date, start-inclusive/end-exclusive check as analytics and the validator; invalid solved timestamps cannot slip through after removal of the aggregate gate.

All three calculation paths share `assigneeAtSolve` and `oneTouchResult` from `worker/src/analytics.js`. The validator re-exports its existing helper names for compatibility.

Attribution uses the latest assignment at or before final `solved_at`, ignoring later assignments. An explicit assignee outside reporting scope is excluded, even if a reporting agent performed the solve. If no valid assignee is available, only the actor of the solve event at the final solved timestamp can supply the fallback. An actor from an earlier solve cannot substitute for a missing final solve event. Timestamps are compared numerically, allowing equivalent ISO representations. Available assignment history can establish attribution even if the exact final solve event is absent.

Public reply counting uses the normalized audit's `publicComment` flag, which the Zendesk client sets only after classifying the author by role. Replies from legitimate agents outside reporting scope count, including Arez when classified as an agent. Requester and private comments do not count. This does not add their solved tickets to reporting totals.

The existing provisional one-touch rule remains at most one public agent reply and zero reopens. API-channel tickets remain unavailable (`null`) and excluded from the one-touch denominator. No new claim about the Explore definition is made.

## Offline evidence

- 36 Zendesk tests pass, including 18 new regressions exercising the scheduled collector, mocked Zendesk responses, in-memory D1 staging statements, and final snapshot bindings.
- Each reporting agent independently stages and finalizes one solved ticket; all four non-Amor cases explicitly assert that Amor has zero solves.
- Cross-path checks cover outside-scope agent replies, requester replies, Arez exclusion, solve-actor fallback, later reassignment, missing final solve events, API-channel exclusion, reopens, and invalid/out-of-day solved timestamps.
- Running the expanded suite against the original three implementation files at `26df317` produces 13 failures; the repaired files produce zero failures.
- 34 applicable existing regressions pass: build output 1, access/content 9, reporting operations access 3, dashboard sync 12, and reporting system 9. The previously recorded nonfatal access/content diagnostic remains outside this change.
- No live Zendesk requests, OAuth refreshes, Production requests, D1 migrations, deployment, or merge were performed. OAuth POST responses and database writes in collector tests are local mocks only.

The October 27 baseline and operational modules are untouched. Changes are limited to the collector, shared Zendesk analytics helpers, validator imports/use of those helpers, Zendesk tests, and this note.

## Required Codex Cloud network configuration

The managed runtime still reports an enforced restricted HTTP policy with no custom allowed hosts. Do not retry the previously blocked destinations until a new enforced allowlist is observed.

Using the supported Codex Cloud environment configuration workflow, add this exact destination hostname to the HTTP/HTTPS custom allowed-host list:

`<configured ZENDESK_SUBDOMAIN>.zendesk.com`

Substitute the already-configured subdomain privately in the environment settings; do not copy a token into network configuration. The GET-only validator needs HTTPS port 443 on that hostname for `/api/v2/users/show_many`, `/api/v2/search/export`, `/api/v2/tickets/{id}/metrics`, and `/api/v2/tickets/{id}/audits`, including same-origin pagination. It does not need a wildcard Zendesk domain, direct TCP grants, or OAuth-token POST access. Preserve the inherited proxy and CA trust.

To independently verify deployed Production as required by the handoff, also allow `sl-cs-knowledge-base.pages.dev` over HTTPS. A redirect to another hostname, if encountered later, requires separate review rather than a broad wildcard rule. GitHub access already works through the current package-manager preset and needs no additional Zendesk-related grant.

Retain `ZENDESK_SUBDOMAIN` plus either `ZENDESK_ACCESS_TOKEN` or both `ZENDESK_EMAIL` and `ZENDESK_API_TOKEN`. After configuration is applied, confirm current runtime observations and enforced policy, then run the existing validator with the injected proxy settings. Authentication, six live identities/roles/active states, token permissions, source CSV reconciliation, and Explore definition verification remain blockers. No blocked request was repeated during this offline fix.

## Recommendation and estimate

GO for review of this isolated offline fix. NO-GO for Production release. Next, apply the narrowly scoped cloud allowlist through its review workflow and perform the first GET-only identity and October 21–22 comparison, retaining the five-agent reporting scope. Estimated experienced-programmer effort for this fix and offline verification: 2–3 hours, excluding live access setup and reconciliation.
