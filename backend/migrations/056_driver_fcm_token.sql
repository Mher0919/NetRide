-- 056: make the legacy single-token driver push column real.
--
-- `drivers.fcm_token` is declared in the Prisma schema and written by
-- `storeFcmToken`/read by `getFcmToken`, but no SQL migration ever created
-- it. On databases provisioned by the SQL migration runner the driver
-- token mirror failed after `device_tokens` had already been written.

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS fcm_token TEXT;
