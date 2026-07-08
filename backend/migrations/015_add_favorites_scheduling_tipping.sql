-- backend/migrations/015_add_favorites_scheduling_tipping.sql

-- 1. Favorite Drivers Table
CREATE TABLE IF NOT EXISTS "favorite_drivers" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "rider_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT "favorite_drivers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "favorite_drivers_rider_id_fkey" FOREIGN KEY ("rider_id") REFERENCES "users"("id") ON DELETE CASCADE,
    CONSTRAINT "favorite_drivers_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE CASCADE,
    CONSTRAINT "unique_favorite" UNIQUE ("rider_id", "driver_id")
);

-- 2. Add Scheduling and Tipping to Rides
ALTER TABLE rides ADD COLUMN IF NOT EXISTS "scheduled_at" TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS "is_scheduled" BOOLEAN DEFAULT FALSE;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS "tip_amount" NUMERIC(10,2) DEFAULT 0;

-- 3. Add Rejection Reason and Feedback State to Users and Drivers
ALTER TABLE users ADD COLUMN IF NOT EXISTS "rejection_reason" TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "verification_feedback_seen" BOOLEAN DEFAULT FALSE;

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS "rejection_reason" TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS "verification_feedback_seen" BOOLEAN DEFAULT FALSE;

-- 4. Create Indexes
CREATE INDEX IF NOT EXISTS "idx_rides_scheduled_at" ON "rides"("scheduled_at") WHERE "is_scheduled" = TRUE;
CREATE INDEX IF NOT EXISTS "idx_favorite_drivers_rider" ON "favorite_drivers"("rider_id");
