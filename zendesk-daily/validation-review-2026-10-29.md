# Zendesk read-only validation review — 2026-10-29

## Source baseline

The repository's `main` branch and `production-baseline-2026-10-27` tag both resolve to `314c45aba88fdb5733a0c6bb784b03035f2d4004` during this review. The Zendesk daily files are not in that baseline; this feature branch carries forward the existing local handoff implementation. The baseline source was checked, but the deployed Cloudflare runtime could not be queried from this environment.

## Authentication and identity checks

The local runtime has none of `ZENDESK_SUBDOMAIN`, `ZENDESK_ACCESS_TOKEN`, `ZENDESK_EMAIL`, or `ZENDESK_API_TOKEN` configured. The validator now supports either pre-issued OAuth Bearer credentials or Zendesk's standard API-token Basic authentication (`email/token:api_token`). It performs identity checks with `GET /api/v2/users/show_many` and never prints or persists credentials.

No authenticated request was possible in this review. The six supplied candidate IDs and their identities, roles, and active status remain unverified. Arez (`7741235860628`) is queried for identity verification only and is excluded from all reporting totals. The reporting scope remains Amor, Gen, Arby, Ford, and Tommy Fang.

## October 21–22 CSV benchmarks

The prior release review records these five-agent benchmarks. The original CSV files are external to the repository and were not available in this runtime, so the figures below are carried forward from that review rather than independently re-read here.

| Date | Solved | One-touch | One-touch rate | Solved by agent: Amor / Gen / Arby / Ford / Tommy |
|---|---:|---:|---:|---|
| 2026-10-21 | 799 | 418 | 52.315394% | 160 / 101 / 82 / 40 / 416 |
| 2026-10-22 | 752 | 433 | 57.579787% | 183 / 80 / 76 / 36 / 377 |

There is no live API result to compare with the CSV in this review; therefore no API-versus-CSV discrepancy is claimed. The validator's one-touch rule counts public agent replies and requires zero reopens, while excluding API-channel tickets from the one-touch denominator. Confirm that this matches the Zendesk Explore report before interpreting any difference as a calculation defect. PHT solve-time boundaries are applied after current Zendesk ticket metrics are fetched. Zendesk does not provide a general point-in-time snapshot, so later ticket changes, reopens, assignment changes, or ratings can produce historical differences even when the calculation is correct. Account-local search indexing and Explore aggregation may also differ from the validator's PHT filter.

## Regression and release status

Focused offline tests use synthetic fixtures and mocks. They do not contact Zendesk, Cloudflare, D1, Supabase, or Google Sheets. No production deployment, migration, or data write was performed. Live parity remains blocked until the execution environment has the Zendesk subdomain and one supported credential set.
