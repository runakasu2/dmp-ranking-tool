ALTER TABLE fetch_jobs DROP CONSTRAINT fetch_jobs_status_check;
ALTER TABLE fetch_jobs ADD CHECK(status IN ('pending','running','done','failed','held','cancelled'));
ALTER TABLE fetch_jobs ADD COLUMN reason text, ADD COLUMN legacy_queue boolean NOT NULL DEFAULT false;
UPDATE fetch_jobs SET legacy_queue=true WHERE status IN ('pending','failed','running');
ALTER TABLE events ADD COLUMN first_fetched_at timestamptz, ADD COLUMN registration_transition_at timestamptz, ADD COLUMN urgent_fetch boolean NOT NULL DEFAULT false;
UPDATE events e SET first_fetched_at=coalesce((
  SELECT min(l.created_at) FROM fetch_logs l JOIN fetch_jobs j ON j.id=l.job_id
  WHERE j.dedupe_key='event:'||e.id AND l.status='done'
),e.last_fetched_at) WHERE last_fetched_at IS NOT NULL;

CREATE TABLE backfill_daily_events (
  day date NOT NULL, event_id bigint NOT NULL REFERENCES events, PRIMARY KEY(day,event_id)
);
CREATE TABLE personal_fetch_coverage (
  season_id bigint REFERENCES seasons, dmp_id integer REFERENCES players,
  succeeded_at timestamptz NOT NULL, starts_on date NOT NULL, through_on date NOT NULL,
  PRIMARY KEY(season_id,dmp_id)
);
CREATE TABLE official_update_baselines (
  season_id bigint REFERENCES seasons, aggregation_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(), rows jsonb NOT NULL,
  PRIMARY KEY(season_id,aggregation_at)
);
CREATE TABLE dmp_traffic_daily (
  day date PRIMARY KEY, bytes bigint NOT NULL CHECK(bytes>=0), measured_at timestamptz NOT NULL
);
CREATE TABLE tracking_candidate_decisions (
  season_id bigint REFERENCES seasons, dmp_id integer REFERENCES players,
  evaluated_at timestamptz NOT NULL DEFAULT now(), details jsonb NOT NULL,
  PRIMARY KEY(season_id,dmp_id)
);
