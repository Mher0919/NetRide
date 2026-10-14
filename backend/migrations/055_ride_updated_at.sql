-- 055: optimistic-concurrency / ordering signal for rides.
--
-- Clients receive ride state over several channels (socket broadcasts, REST
-- reads, push-triggered reconciliation). Without a per-entity version an
-- older payload can overwrite a newer one after a reconnect. `updated_at`
-- is bumped on every status-affecting write and is included in every ride
-- payload so clients can drop stale events deterministically.

ALTER TABLE rides ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_rides_updated_at ON rides (updated_at DESC);
