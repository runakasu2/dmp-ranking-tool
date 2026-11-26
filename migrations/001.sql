CREATE TABLE players (
 dmp_id integer PRIMARY KEY CHECK(dmp_id>0), handle_name text NOT NULL, prefecture text, region text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE player_name_history (
 dmp_id integer REFERENCES players, name text NOT NULL, observed_at timestamptz DEFAULT clock_timestamp(),
 PRIMARY KEY(dmp_id,observed_at)
);
CREATE TABLE seasons (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, source_term text NOT NULL, legacy_term text NOT NULL,
 starts_on date NOT NULL, ends_on date NOT NULL CHECK(ends_on>=starts_on),
 finalized_at timestamptz, compacted_at timestamptz, initialized_at timestamptz,
 EXCLUDE USING gist (daterange(starts_on,ends_on,'[]') WITH &&)
);
CREATE TABLE aggregation_rules (
 season_id bigint REFERENCES seasons, version integer CHECK(version>0), weekly_limit integer NOT NULL CHECK(weekly_limit BETWEEN 0 AND 20),
 grade_rules jsonb NOT NULL, effective_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(season_id,version)
);
CREATE TABLE events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, season_id bigint NOT NULL REFERENCES seasons,
 event_year integer NOT NULL, shop_id integer NOT NULL CHECK(shop_id>0), source_event_id integer NOT NULL CHECK(source_event_id>0), held_id integer NOT NULL CHECK(held_id>=0),
 event_date date NOT NULL CHECK(event_year=extract(year FROM event_date)), event_name text NOT NULL, grade text NOT NULL CHECK(grade IN ('CS','CSE','GP','BN')),
 prefecture text, shop_name text, format text, is_team boolean NOT NULL, multiplier numeric CHECK(multiplier>=0), approval text,
 result_status text NOT NULL DEFAULT 'unregistered' CHECK(result_status IN ('unregistered','registered','fetched')),
 first_detected_at timestamptz DEFAULT now(), result_registered_at timestamptz, last_fetched_at timestamptz, next_fetch_at timestamptz,
 result_hash text, official_reflected_at timestamptz, UNIQUE(event_year,shop_id,source_event_id,held_id)
);
CREATE INDEX events_schedule ON events(season_id,event_date,next_fetch_at);
CREATE TABLE event_results (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event_id bigint NOT NULL REFERENCES events, dmp_id integer NOT NULL REFERENCES players,
 source_result_id text, placement integer CHECK(placement>0), rank_points integer CHECK(rank_points>=0), judge_bonus integer CHECK(judge_bonus>=0),
 total_points integer NOT NULL CHECK(total_points>=0), official_counted boolean, provisional_counted boolean NOT NULL DEFAULT false,
 source_updated_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(), active boolean NOT NULL DEFAULT true,
 source text NOT NULL CHECK(source IN ('event','personal')), coverage text NOT NULL,
 UNIQUE(event_id,dmp_id)
);
CREATE INDEX results_player ON event_results(dmp_id,event_id) WHERE active;
CREATE TABLE event_result_changes (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event_result_id bigint NOT NULL REFERENCES event_results,
 changed_fields jsonb NOT NULL, detected_at timestamptz NOT NULL DEFAULT clock_timestamp(), source_updated_at timestamptz
);
CREATE INDEX result_changes_lookup ON event_result_changes(event_result_id,detected_at);
CREATE TABLE official_rankings (
 season_id bigint REFERENCES seasons,dmp_id integer REFERENCES players,rank integer NOT NULL CHECK(rank>0),points integer NOT NULL CHECK(points>=0),
 aggregation_at timestamptz NOT NULL, PRIMARY KEY(season_id,dmp_id)
);
CREATE INDEX official_order ON official_rankings(season_id,rank,dmp_id);
CREATE TABLE official_history (
 season_id bigint REFERENCES seasons, aggregation_at timestamptz, dmp_id integer REFERENCES players,
 rank integer NOT NULL CHECK(rank>0),points integer NOT NULL CHECK(points>=0), PRIMARY KEY(season_id,aggregation_at,dmp_id)
);
CREATE TABLE weekly_points (
 season_id bigint REFERENCES seasons,dmp_id integer REFERENCES players,week_start date,
 weekly_counted_points integer NOT NULL,extra_points integer NOT NULL,total_points integer NOT NULL,rule_version integer NOT NULL,
 PRIMARY KEY(season_id,dmp_id,week_start),FOREIGN KEY(season_id,rule_version) REFERENCES aggregation_rules(season_id,version)
);
CREATE TABLE provisional_rankings (
 season_id bigint REFERENCES seasons,dmp_id integer REFERENCES players,rank integer NOT NULL CHECK(rank>0),points integer NOT NULL CHECK(points>=0),
 coverage text NOT NULL,status text NOT NULL,calculated_at timestamptz NOT NULL, PRIMARY KEY(season_id,dmp_id)
);
CREATE TABLE provisional_history (
 season_id bigint REFERENCES seasons,dmp_id integer REFERENCES players,rank integer,points integer,tracked boolean NOT NULL,status text NOT NULL,
 batch_id bigint,observed_at timestamptz NOT NULL, day date, best_rank integer,worst_rank integer,
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, UNIQUE(season_id,dmp_id,day)
);
CREATE INDEX provisional_history_lookup ON provisional_history(season_id,observed_at,id);
CREATE TABLE tracked_players (
 season_id bigint REFERENCES seasons,dmp_id integer REFERENCES players,reasons text[] NOT NULL DEFAULT '{}',active boolean NOT NULL DEFAULT true,
 last_requested_at timestamptz,backfill_status text NOT NULL DEFAULT 'pending' CHECK(backfill_status IN ('pending','ready','partial','stale')),
 PRIMARY KEY(season_id,dmp_id)
);
CREATE TABLE fetch_jobs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,type text NOT NULL,payload jsonb NOT NULL,dedupe_key text NOT NULL UNIQUE,priority integer NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed')),
 attempts integer NOT NULL DEFAULT 0,next_run_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,
 lease_token uuid,checkpoint jsonb,created_at timestamptz NOT NULL DEFAULT now(),last_error text
);
CREATE INDEX jobs_ready ON fetch_jobs(priority,next_run_at,id) WHERE status IN ('pending','running','failed');
CREATE TABLE fetch_logs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, job_id bigint REFERENCES fetch_jobs ON DELETE SET NULL,status text NOT NULL,
 bytes bigint NOT NULL DEFAULT 0, duration integer NOT NULL DEFAULT 0, records integer NOT NULL DEFAULT 0,error text,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fetch_logs_created ON fetch_logs(created_at);
CREATE TABLE sync_discrepancies (
 season_id bigint REFERENCES seasons,dmp_id integer REFERENCES players,aggregation_at timestamptz,official_points integer NOT NULL,
 computed_points integer,status text NOT NULL,details jsonb NOT NULL DEFAULT '{}',PRIMARY KEY(season_id,dmp_id,aggregation_at)
);
CREATE TABLE app_settings (key text PRIMARY KEY,value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE admin_accounts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,login text NOT NULL UNIQUE,password_hash text NOT NULL,role text NOT NULL CHECK(role='admin')
);
CREATE TABLE admin_sessions (session_hash text PRIMARY KEY,admin_id bigint REFERENCES admin_accounts ON DELETE CASCADE,expires_at timestamptz NOT NULL);
CREATE TABLE backup_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(),status text NOT NULL,
 storage_reference text,checksum text, verified_at timestamptz
);
CREATE TABLE aggregation_batches (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,season_id bigint NOT NULL REFERENCES seasons,observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE provisional_history ADD FOREIGN KEY (batch_id) REFERENCES aggregation_batches;
CREATE TABLE pending_personal_results (
 season_id bigint REFERENCES seasons,dmp_id integer REFERENCES players,event_key text NOT NULL,data jsonb NOT NULL,
 PRIMARY KEY(season_id,dmp_id,event_key)
);
