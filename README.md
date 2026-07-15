# SocialLoop CS Base

SocialLoop CS Base is a Cloudflare Pages site backed by Supabase. It provides authenticated knowledge-base content, user and article management, and Google Sheet-synchronized customer-support reporting.

## Active application areas

- Landing and authentication: `index.html`, `login.html`, `change-password.html`
- Knowledge base: `KB.html`, `article.html`, `add-article.html`, `article-management.html`
- Employee administration: `workforce.html` (`user-management.html` redirects here)
- Reporting: `dashboard.html`, `report-details.html`, `agent-analytics.html`, `response-times.html`, `reporting-operations.html`
- Google Sheet ingestion: `functions/api/sync-dashboard.js` and `apps-script/dashboard-sync.gs`

## Data-source boundary

Google Sheet synchronization is the only active reporting source. The live reporting pages do not depend on Zendesk APIs or Zendesk event tables. Missing workbook metrics remain unavailable instead of being inferred.

## Repository layout

- `styles/` — site stylesheets
- `scripts/` — browser modules
- `functions/` — Cloudflare Pages Functions
- `config/` — active synchronization mappings
- `apps-script/` — Google Apps Script used by the source workbook
- `supabase/migrations/` — ordered database changes
- `supabase/verification/` — read-only operational checks
- `docs/` — current setup and operations documentation
- `tests/` — active regression and repository-integrity tests

## Development checks

```bash
npm test
```

GitHub Actions runs the same test suite and syntax-checks active JavaScript files.

## Database files

Migration filenames retain their timestamp prefixes because those prefixes are their migration versions. Descriptive suffixes do not contain temporary phase or step labels. See `docs/database-maintenance.md` before changing or applying database files.
