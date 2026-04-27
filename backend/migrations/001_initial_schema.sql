-- backend/migrations/001_initial_schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enums
DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('RIDER', 'DRIVER');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE background_check_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE trip_status AS ENUM ('REQUESTED', 'ACCEPTED', 'DRIVER_ARRIVING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE vehicle_category AS ENUM ('ECONOMY', 'PREMIUM', 'SUV', 'VAN');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Tables
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role              user_role NOT NULL,
  email             TEXT UNIQUE NOT NULL,
  phone_number      TEXT UNIQUE,
  full_name         TEXT NOT NULL,
  date_of_birth     TIMESTAMPTZ,
  profile_image_url TEXT,
  is_verified       BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drivers (
  user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  license_number          TEXT,
  license_expiry_date     TIMESTAMPTZ,
  license_photo_url       TEXT,
  background_check_status background_check_status DEFAULT 'PENDING',
  rating                  NUMERIC(3,2) DEFAULT 5.00,
  total_rides             INT DEFAULT 0,
  is_active               BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS vehicles (
  id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  make     TEXT NOT NULL,
  model    TEXT NOT NULL,
  year     INT NOT NULL,
  category vehicle_category NOT NULL
);

CREATE TABLE IF NOT EXISTS driver_vehicles (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id                 UUID REFERENCES drivers(user_id) ON DELETE CASCADE,
  vehicle_id                UUID REFERENCES vehicles(id) ON DELETE CASCADE,
  license_plate_number      TEXT NOT NULL,
  license_plate_photo_url   TEXT,
  car_photo_urls            TEXT[] -- PostgreSQL supports arrays
);

CREATE TABLE IF NOT EXISTS rides (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rider_id            UUID REFERENCES users(id),
  driver_id           UUID REFERENCES users(id),
  status              trip_status DEFAULT 'REQUESTED',
  pickup_lat          DOUBLE PRECISION,
  pickup_lng          DOUBLE PRECISION,
  pickup_address      TEXT,
  destination_lat     DOUBLE PRECISION,
  destination_lng     DOUBLE PRECISION,
  destination_address TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ratings (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ride_id     UUID UNIQUE REFERENCES rides(id),
  rider_id    UUID REFERENCES users(id),
  driver_id   UUID REFERENCES users(id),
  rating      INT CHECK (rating >= 1 AND rating <= 5),
  review_text TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Seed Data (Vehicles)
INSERT INTO vehicles (make, model, year, category) VALUES 
('Tesla', 'Model 3', 2023, 'ECONOMY'),
('Tesla', 'Model Y', 2023, 'SUV'),
('Tesla', 'Model S', 2023, 'PREMIUM'),
('Toyota', 'Camry', 2022, 'ECONOMY'),
('Toyota', 'Rav4', 2022, 'SUV'),
('Toyota', 'Sienna', 2022, 'VAN'),
('Honda', 'Accord', 2022, 'ECONOMY'),
('Honda', 'CR-V', 2022, 'SUV'),
('Honda', 'Odyssey', 2022, 'VAN'),
('Mercedes-Benz', 'E-Class', 2023, 'PREMIUM'),
('BMW', '5 Series', 2023, 'PREMIUM'),
('Cadillac', 'Escalade', 2023, 'SUV')
ON CONFLICT DO NOTHING;
