ALTER TABLE event_results ADD COLUMN source_details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE official_rankings ADD COLUMN source_details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE official_history ADD COLUMN source_details jsonb NOT NULL DEFAULT '{}';
