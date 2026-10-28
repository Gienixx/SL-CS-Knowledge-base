PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS run_log (
  run_id TEXT PRIMARY KEY,
  reporting_day TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','incomplete','complete','failed','late')),
  scheduled_for TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  source_watermark TEXT,
  next_page_url TEXT,
  pages_processed INTEGER NOT NULL DEFAULT 0,
  tickets_seen INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  message TEXT,
  UNIQUE (reporting_day, run_id)
);

CREATE INDEX IF NOT EXISTS run_log_day_idx ON run_log(reporting_day, started_at DESC);

CREATE TABLE IF NOT EXISTS run_lock (
  lock_name TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  locked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_state (
  name TEXT PRIMARY KEY,
  encrypted_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staged_metrics (
  run_id TEXT NOT NULL REFERENCES run_log(run_id),
  ticket_id INTEGER NOT NULL,
  agent_key TEXT NOT NULL,
  metric_json TEXT NOT NULL,
  PRIMARY KEY (run_id, ticket_id)
);

CREATE TABLE IF NOT EXISTS daily_snapshot (
  reporting_day TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  agent_label TEXT NOT NULL,
  solved_tickets INTEGER NOT NULL,
  first_reply_minutes REAL,
  requester_wait_minutes REAL,
  last_assignment_to_resolution_minutes REAL,
  full_resolution_minutes REAL,
  csat_percent REAL,
  one_touch_percent REAL,
  csat_responses INTEGER NOT NULL,
  one_touch_denominator INTEGER NOT NULL,
  run_id TEXT NOT NULL REFERENCES run_log(run_id),
  intended_cutoff TEXT NOT NULL,
  actual_started_at TEXT NOT NULL,
  actual_completed_at TEXT NOT NULL,
  source_watermark TEXT,
  quality_status TEXT NOT NULL CHECK (quality_status IN ('on_time','late','incomplete')),
  PRIMARY KEY (reporting_day, agent_key)
);

CREATE TRIGGER IF NOT EXISTS daily_snapshot_no_update
BEFORE UPDATE ON daily_snapshot BEGIN SELECT RAISE(ABORT, 'finalized Zendesk snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS daily_snapshot_no_delete
BEFORE DELETE ON daily_snapshot BEGIN SELECT RAISE(ABORT, 'finalized Zendesk snapshots are immutable'); END;

CREATE TABLE IF NOT EXISTS correction_log (
  correction_id TEXT PRIMARY KEY,
  reporting_day TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  reason TEXT NOT NULL,
  old_values_json TEXT NOT NULL,
  new_values_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS correction_values (
  correction_id TEXT NOT NULL REFERENCES correction_log(correction_id),
  metric_name TEXT NOT NULL,
  metric_value REAL,
  PRIMARY KEY (correction_id, metric_name)
);

CREATE TRIGGER IF NOT EXISTS correction_log_no_update
BEFORE UPDATE ON correction_log BEGIN SELECT RAISE(ABORT, 'correction audit rows are append only'); END;
CREATE TRIGGER IF NOT EXISTS correction_log_no_delete
BEFORE DELETE ON correction_log BEGIN SELECT RAISE(ABORT, 'correction audit rows are append only'); END;
CREATE TRIGGER IF NOT EXISTS correction_values_no_update
BEFORE UPDATE ON correction_values BEGIN SELECT RAISE(ABORT, 'correction values are append only'); END;
CREATE TRIGGER IF NOT EXISTS correction_values_no_delete
BEFORE DELETE ON correction_values BEGIN SELECT RAISE(ABORT, 'correction values are append only'); END;

CREATE VIEW IF NOT EXISTS effective_daily_snapshot AS
WITH ranked_values AS (
  SELECT l.reporting_day,l.agent_key,v.metric_name,v.metric_value,
         ROW_NUMBER() OVER (PARTITION BY l.reporting_day,l.agent_key,v.metric_name ORDER BY l.created_at DESC,l.correction_id DESC) AS rank
  FROM correction_log l JOIN correction_values v ON v.correction_id=l.correction_id
)
SELECT s.reporting_day, s.agent_key, s.agent_label,
       CASE WHEN MAX(CASE WHEN cv.metric_name='solved_tickets' THEN 1 ELSE 0 END)=1 THEN MAX(CASE WHEN cv.metric_name='solved_tickets' THEN cv.metric_value END) ELSE s.solved_tickets END AS solved_tickets,
       CASE WHEN MAX(CASE WHEN cv.metric_name='first_reply_minutes' THEN 1 ELSE 0 END)=1 THEN MAX(CASE WHEN cv.metric_name='first_reply_minutes' THEN cv.metric_value END) ELSE s.first_reply_minutes END AS first_reply_minutes,
       CASE WHEN MAX(CASE WHEN cv.metric_name='requester_wait_minutes' THEN 1 ELSE 0 END)=1 THEN MAX(CASE WHEN cv.metric_name='requester_wait_minutes' THEN cv.metric_value END) ELSE s.requester_wait_minutes END AS requester_wait_minutes,
       CASE WHEN MAX(CASE WHEN cv.metric_name='last_assignment_to_resolution_minutes' THEN 1 ELSE 0 END)=1 THEN MAX(CASE WHEN cv.metric_name='last_assignment_to_resolution_minutes' THEN cv.metric_value END) ELSE s.last_assignment_to_resolution_minutes END AS last_assignment_to_resolution_minutes,
       CASE WHEN MAX(CASE WHEN cv.metric_name='full_resolution_minutes' THEN 1 ELSE 0 END)=1 THEN MAX(CASE WHEN cv.metric_name='full_resolution_minutes' THEN cv.metric_value END) ELSE s.full_resolution_minutes END AS full_resolution_minutes,
       CASE WHEN MAX(CASE WHEN cv.metric_name='csat_percent' THEN 1 ELSE 0 END)=1 THEN MAX(CASE WHEN cv.metric_name='csat_percent' THEN cv.metric_value END) ELSE s.csat_percent END AS csat_percent,
       CASE WHEN MAX(CASE WHEN cv.metric_name='one_touch_percent' THEN 1 ELSE 0 END)=1 THEN MAX(CASE WHEN cv.metric_name='one_touch_percent' THEN cv.metric_value END) ELSE s.one_touch_percent END AS one_touch_percent,
       s.csat_responses, s.one_touch_denominator, s.run_id, s.intended_cutoff,
       s.actual_started_at, s.actual_completed_at, s.source_watermark, s.quality_status
FROM daily_snapshot s
LEFT JOIN ranked_values cv ON cv.reporting_day=s.reporting_day AND cv.agent_key=s.agent_key AND cv.rank=1
GROUP BY s.reporting_day, s.agent_key;
