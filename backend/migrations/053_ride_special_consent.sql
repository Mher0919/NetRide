-- backend/migrations/053_ride_special_consent.sql
--
-- Explicit, auditable rider consent for the Special no-show fallback: the
-- rider agrees that if the sponsor code is not validated before the deadline,
-- NetRide may collect the remaining fare (the sponsor-subsidised portion)
-- from their payment method. Recorded server-side at ride request.

ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS special_terms_accepted_at TIMESTAMPTZ;
