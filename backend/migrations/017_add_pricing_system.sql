-- backend/migrations/017_add_pricing_system.sql

ALTER TABLE drivers
ADD COLUMN price_per_mile DECIMAL(10, 2),
ADD COLUMN price_range_min DECIMAL(10, 2),
ADD COLUMN price_range_max DECIMAL(10, 2),
ADD COLUMN recommended_price DECIMAL(10, 2),
ADD COLUMN price_last_changed TIMESTAMPTZ,
ADD COLUMN is_dangerous BOOLEAN DEFAULT FALSE,
ADD COLUMN is_flagged BOOLEAN DEFAULT FALSE;

ALTER TABLE rides
ADD COLUMN initial_max_fare DECIMAL(10, 2),
ADD COLUMN saving_likelihood INT;
