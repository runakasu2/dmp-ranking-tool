-- NULL denotes a consumed slot. An owned token is an outstanding dispatch
-- reservation. An orphan token is retained because it may have sent.
ALTER TABLE backfill_daily_events ADD COLUMN reservation_token uuid;
