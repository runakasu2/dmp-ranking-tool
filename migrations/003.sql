CREATE TABLE job_event_pages (
 job_id bigint REFERENCES fetch_jobs ON DELETE CASCADE,
 page_offset integer CHECK(page_offset>=0 AND page_offset%30=0),
 data jsonb NOT NULL CHECK(jsonb_typeof(data)='array'),
 page_hash text NOT NULL,
 PRIMARY KEY(job_id,page_offset), UNIQUE(job_id,page_hash)
);
ALTER TABLE events ADD COLUMN range_check jsonb;
