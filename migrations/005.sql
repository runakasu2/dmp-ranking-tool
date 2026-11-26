-- This flag marks initial data availability. Official point audit results
-- remain independently recorded in sync_discrepancies.
CREATE VIEW season_initial_data_ready AS
SELECT s.id FROM seasons s
WHERE (
    EXISTS (SELECT 1 FROM official_rankings o WHERE o.season_id=s.id AND o.rank<=200)
    AND NOT EXISTS (
      SELECT 1 FROM official_rankings o
      LEFT JOIN tracked_players t USING(season_id,dmp_id)
      LEFT JOIN provisional_rankings r USING(season_id,dmp_id)
      WHERE o.season_id=s.id AND o.rank<=200 AND
        (t.active IS DISTINCT FROM true OR t.backfill_status IS DISTINCT FROM 'ready'
          OR r.status IS DISTINCT FROM 'ready')
    )
  ) OR (
    NOT EXISTS (SELECT 1 FROM official_rankings o WHERE o.season_id=s.id)
    AND EXISTS (SELECT 1 FROM seasons earlier WHERE earlier.ends_on<s.starts_on)
    AND EXISTS (
      SELECT 1 FROM tracked_players t JOIN provisional_rankings r USING(season_id,dmp_id)
      WHERE t.season_id=s.id AND t.active AND t.backfill_status='ready' AND r.status='ready'
    )
    AND NOT EXISTS (
      SELECT 1 FROM tracked_players t LEFT JOIN provisional_rankings r USING(season_id,dmp_id)
      WHERE t.season_id=s.id AND t.active
        AND (t.backfill_status<>'ready' OR r.status IS DISTINCT FROM 'ready')
    )
  );

UPDATE seasons s SET initialized_at=now()
WHERE s.initialized_at IS NULL AND EXISTS (SELECT 1 FROM season_initial_data_ready v WHERE v.id=s.id);
