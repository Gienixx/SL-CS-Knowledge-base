# Zendesk integration archive

This document is retained only as a historical reference for the previous Cloudflare and Zendesk synchronization design.

As of Phase 3 Step 8, Zendesk synchronization and Zendesk-derived reporting are disabled. The synchronized Google Sheet dataset is the only active reporting source.

Current implementation and validation instructions are documented in:

```text
docs/phase-3-step-8-google-sheet-cutover.md
```

The former Zendesk Pages endpoints now return the shared `zendesk_integration_disabled` response. The scheduled Worker is retained as a no-op so an older active deployment is replaced safely after merge.

Existing Zendesk-related Supabase tables, migrations, and historical records remain preserved temporarily. They are not used by the active dashboard and are not removed in Step 8.
