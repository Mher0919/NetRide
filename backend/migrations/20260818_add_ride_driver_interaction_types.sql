-- backend/migrations/20260818_add_ride_driver_interaction_types.sql
--
-- RideDriverHistory — driver-specific ride interaction history (matches the
-- same (ride, driver) pair, one terminal interaction per driver per ride).
--
-- Extends the existing `ride_driver_rejections` table (the deployed dispatch
-- exclusion store) into the rideDriverHistory concept:
--
--   interaction_type:
--     'REJECTED'                 driver declined BEFORE accepting
--     'ACCEPTED_THEN_CANCELLED'  driver accepted, then cancelled pre-pickup
--
-- For MATCHING purposes both types mean the same thing: the (ride, driver)
-- pair is EXCLUDED from future matching. The interaction_type column only
-- preserves the history type for analytics/auditing (§12 of the production
-- fix spec). Existing rows backfill as REJECTED.

ALTER TABLE ride_driver_rejections DROP CONSTRAINT IF EXISTS ride_driver_rejections_status_check;

ALTER TABLE ride_driver_rejections ALTER COLUMN status DROP DEFAULT;

ALTER TABLE ride_driver_rejections ADD COLUMN IF NOT EXISTS interaction_type TEXT;

UPDATE ride_driver_rejections
   SET interaction_type = 'REJECTED'
 WHERE interaction_type IS NULL;

ALTER TABLE ride_driver_rejections
  ALTER COLUMN interaction_type SET NOT NULL,
  ALTER COLUMN interaction_type SET DEFAULT 'REJECTED';

ALTER TABLE ride_driver_rejections
  ADD CONSTRAINT ride_driver_rejections_interaction_type_check
  CHECK (interaction_type IN ('REJECTED', 'ACCEPTED_THEN_CANCELLED'));

-- Reason captured when a driver cancels after accepting (audit trail).
ALTER TABLE ride_driver_rejections ADD COLUMN IF NOT EXISTS reason_code TEXT;
ALTER TABLE ride_driver_rejections ADD COLUMN IF NOT EXISTS reason_text TEXT;
