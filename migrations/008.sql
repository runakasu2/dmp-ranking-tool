CREATE TABLE candidate_daily_players (
  day date NOT NULL, dmp_id integer NOT NULL REFERENCES players,
  reservation_token uuid, PRIMARY KEY(day,dmp_id)
);
CREATE INDEX fetch_jobs_schedule_range ON fetch_jobs
  ((payload->>'season'),(payload->>'grade'),(payload->>'from'),(payload->>'to'))
  WHERE type IN ('schedule','complete-schedule') AND status IN ('pending','running');
ALTER TABLE fetch_logs ADD COLUMN received_bytes bigint;
