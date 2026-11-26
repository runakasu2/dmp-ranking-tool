ALTER TABLE fetch_jobs ADD COLUMN started_at timestamptz, ADD COLUMN finished_at timestamptz;
ALTER TABLE fetch_logs ADD COLUMN started_at timestamptz, ADD COLUMN finished_at timestamptz,
  ADD COLUMN phase_ms jsonb;

-- Live telemetry can be updated independently of the result transaction.
CREATE TABLE fetch_job_progress (
  job_id bigint PRIMARY KEY REFERENCES fetch_jobs ON DELETE CASCADE,
  lease_token uuid NOT NULL,
  phase text NOT NULL,
  phase_started_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
