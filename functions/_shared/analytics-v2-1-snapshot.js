// Saved verification, not a live feed. See zendesk-daily/agent-updates-verification-2026-11-03.md.
export const snapshot = {
  date: '2026-10-30', timezone: 'America/New_York', group: 'Support',
  classification: 'Reconstructed from Support API',
  streamThrough: '2026-11-02T20:24:07Z',
  rows: [
    { agent: 'Arby', updates: 0, comments: 0, public: 0, internal: 0, commented: 0, solved: 0, created: 0 },
    { agent: 'Gen', updates: 170, comments: 170, public: 63, internal: 107, commented: 156, solved: 86, created: 0 },
    { agent: 'Arez', updates: 0, comments: 0, public: 0, internal: 0, commented: 0, solved: 0, created: 0 },
    { agent: 'Tommy Fang', updates: 1607, comments: 860, public: 571, internal: 289, commented: 515, solved: 285, created: 0 }
  ],
  // Known intersection from the completed verification; never sum distinct-ticket rows blindly.
  commentedIntersection: { agents: ['Gen', 'Tommy Fang'], count: 78 }
}
