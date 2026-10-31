-- 20261030_group_rides.sql
--
-- GROUP RIDES, FRIENDS, CONTACT INVITATIONS, MULTI-STOP ROUTES AND
-- PER-PARTICIPANT PAYMENTS.
--
-- Design notes
-- ------------
-- * A group ride is still a single row in `rides` (the host is rider_id), so
--   the existing dispatch/matching, driver navigation, completion, ratings,
--   live location and admin surfaces keep working unchanged.
-- * The group is the coordination object: membership, chat, invitations,
--   versioned quotes, route plans and individual payment records.
-- * Money is integer cents everywhere. The backend is the only writer.
-- * Every application-owned table is deny-by-default for the Supabase
--   anon/authenticated roles (RLS enabled + grants revoked). The trusted
--   backend owner connection bypasses RLS exactly like the rest of NetRide.
--   PostGIS-owned objects (spatial_ref_sys and the geometry metadata views)
--   are deliberately untouched.
-- * All statements are idempotent so the migration runner can replay safely.

-- ---------------------------------------------------------------------------
-- 1. FRIENDSHIPS (canonical unordered pair with an explicit requester)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS friendships (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_low     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT        NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'BLOCKED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT friendships_ordered_pair CHECK (user_low < user_high),
  CONSTRAINT friendships_requester_is_party CHECK (requested_by IN (user_low, user_high)),
  CONSTRAINT friendships_unique_pair UNIQUE (user_low, user_high)
);

CREATE INDEX IF NOT EXISTS friendships_low_status_idx
  ON friendships (user_low, status);
CREATE INDEX IF NOT EXISTS friendships_high_status_idx
  ON friendships (user_high, status);

-- ---------------------------------------------------------------------------
-- 2. CONFIGURABLE GROUP BUSINESS RULES (singleton)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ride_group_settings (
  id                   INTEGER     PRIMARY KEY DEFAULT 1,
  max_participants     INTEGER     NOT NULL DEFAULT 5 CHECK (max_participants BETWEEN 2 AND 5),
  quote_ttl_seconds    INTEGER     NOT NULL DEFAULT 1200 CHECK (quote_ttl_seconds BETWEEN 60 AND 86400),
  invite_ttl_seconds   INTEGER     NOT NULL DEFAULT 604800 CHECK (invite_ttl_seconds BETWEEN 300 AND 2592000),
  route_plan_ttl_seconds INTEGER   NOT NULL DEFAULT 1800 CHECK (route_plan_ttl_seconds BETWEEN 60 AND 86400),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ride_group_settings_singleton CHECK (id = 1)
);

INSERT INTO ride_group_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. GROUP + MEMBERSHIP
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ride_groups (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  host_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  status          TEXT        NOT NULL DEFAULT 'COLLECTING_MEMBERS'
                              CHECK (status IN (
                                'DRAFT', 'COLLECTING_MEMBERS', 'CONFIGURING',
                                'AWAITING_PAYMENT', 'READY_TO_REQUEST',
                                'RIDE_REQUESTED', 'DRIVER_MATCHING',
                                'DRIVER_ASSIGNED', 'IN_PROGRESS', 'COMPLETED',
                                'CANCELLED', 'EXPIRED'
                              )),
  destination_lat   DOUBLE PRECISION,
  destination_lng   DOUBLE PRECISION,
  destination_address TEXT,
  destination_place_id TEXT,
  vehicle_category TEXT        NOT NULL DEFAULT 'CORE',
  split_method     TEXT        NOT NULL DEFAULT 'HOST_PAYS'
                              CHECK (split_method IN ('HOST_PAYS', 'EQUAL', 'DISTANCE', 'CUSTOM')),
  active_ride_id   UUID,
  current_quote_id UUID,
  configuration_version INT    NOT NULL DEFAULT 0,
  locked_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ride_groups_host_created_idx
  ON ride_groups (host_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ride_groups_status_idx
  ON ride_groups (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS ride_group_members (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id        UUID        NOT NULL REFERENCES ride_groups(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT        NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('HOST', 'MEMBER')),
  status          TEXT        NOT NULL DEFAULT 'JOINED'
                              CHECK (status IN (
                                'INVITED', 'JOINED', 'PICKUP_PENDING',
                                'PICKUP_CONFIRMED', 'PICKED_UP', 'COMPLETED',
                                'LEFT', 'REMOVED', 'CANCELLED', 'NO_SHOW'
                              )),
  pickup_lat      DOUBLE PRECISION,
  pickup_lng      DOUBLE PRECISION,
  pickup_address  TEXT,
  pickup_place_id TEXT,
  pickup_source   TEXT        CHECK (pickup_source IN ('HOST', 'SELF')),
  pickup_set_at   TIMESTAMPTZ,
  payment_status  TEXT        NOT NULL DEFAULT 'NOT_REQUIRED'
                              CHECK (payment_status IN (
                                'NOT_REQUIRED', 'PENDING', 'PROCESSING',
                                'SUCCEEDED', 'FAILED', 'REFUNDED', 'CANCELLED'
                              )),
  last_read_at    TIMESTAMPTZ,
  joined_at       TIMESTAMPTZ,
  picked_up_at    TIMESTAMPTZ,
  left_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ride_group_members_unique_user UNIQUE (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS ride_group_members_user_idx
  ON ride_group_members (user_id, status);
CREATE INDEX IF NOT EXISTS ride_group_members_group_idx
  ON ride_group_members (group_id, status);

-- Capacity is enforced atomically at the database layer. The service also
-- locks the group row, so concurrent acceptances cannot overshoot the limit.
CREATE OR REPLACE FUNCTION enforce_group_member_capacity()
RETURNS TRIGGER AS $$
DECLARE
  active_count INTEGER;
  max_allowed INTEGER;
BEGIN
  IF NEW.status = 'JOINED'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'JOINED') THEN
    -- Serialize all joins for this group on the group row.
    PERFORM 1 FROM ride_groups WHERE id = NEW.group_id FOR UPDATE;
    SELECT max_participants INTO max_allowed FROM ride_group_settings WHERE id = 1;
    max_allowed := COALESCE(max_allowed, 5);
    SELECT COUNT(*) INTO active_count
      FROM ride_group_members
     WHERE group_id = NEW.group_id
       AND status = 'JOINED'
       AND user_id <> NEW.user_id;
    IF active_count >= max_allowed THEN
      RAISE EXCEPTION 'GROUP_FULL' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ride_group_members_capacity ON ride_group_members;
CREATE TRIGGER ride_group_members_capacity
  BEFORE INSERT OR UPDATE OF status ON ride_group_members
  FOR EACH ROW EXECUTE FUNCTION enforce_group_member_capacity();

-- Trigger functions are never client-callable. Remove the default PUBLIC
-- EXECUTE grant even though they cannot be usefully invoked directly.
REVOKE ALL ON FUNCTION enforce_group_member_capacity() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION enforce_group_member_capacity() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION enforce_group_member_capacity() FROM authenticated';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. INVITATIONS (secure, expiring, revocable, single-use)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ride_group_invitations (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id          UUID        NOT NULL REFERENCES ride_groups(id) ON DELETE CASCADE,
  inviter_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_user_id   UUID        REFERENCES users(id) ON DELETE SET NULL,
  invited_phone     TEXT,
  invited_name      TEXT,
  -- Only the SHA-256 hash of the bearer token is stored. The raw token is
  -- returned exactly once to the inviter and embedded in the SMS link.
  token_hash        TEXT        NOT NULL UNIQUE,
  status            TEXT        NOT NULL DEFAULT 'PENDING'
                                CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED')),
  expires_at        TIMESTAMPTZ NOT NULL,
  accepted_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ride_group_invitations_group_status_idx
  ON ride_group_invitations (group_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ride_group_invitations_user_idx
  ON ride_group_invitations (invited_user_id, status);
CREATE INDEX IF NOT EXISTS ride_group_invitations_phone_idx
  ON ride_group_invitations (invited_phone, status);

CREATE UNIQUE INDEX IF NOT EXISTS ride_group_invitations_pending_user_uniq
  ON ride_group_invitations (group_id, invited_user_id)
  WHERE status = 'PENDING' AND invited_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ride_group_invitations_pending_phone_uniq
  ON ride_group_invitations (group_id, invited_phone)
  WHERE status = 'PENDING' AND invited_phone IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_group_invitation_capacity()
RETURNS TRIGGER AS $$
DECLARE
  active_count INTEGER;
  pending_count INTEGER;
  max_allowed INTEGER;
BEGIN
  IF NEW.status = 'PENDING' THEN
    PERFORM 1 FROM ride_groups WHERE id = NEW.group_id FOR UPDATE;
    SELECT max_participants INTO max_allowed FROM ride_group_settings WHERE id = 1;
    max_allowed := COALESCE(max_allowed, 5);
    SELECT COUNT(*) INTO active_count
      FROM ride_group_members
     WHERE group_id = NEW.group_id AND status = 'JOINED';
    SELECT COUNT(*) INTO pending_count
      FROM ride_group_invitations
     WHERE group_id = NEW.group_id AND status = 'PENDING';
    -- One host + up to four friends. Pending invitations reserve a slot until
    -- accepted, declined, revoked or expired.
    IF active_count + pending_count >= max_allowed THEN
      RAISE EXCEPTION 'GROUP_FULL' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ride_group_invitations_capacity ON ride_group_invitations;
CREATE TRIGGER ride_group_invitations_capacity
  BEFORE INSERT ON ride_group_invitations
  FOR EACH ROW EXECUTE FUNCTION enforce_group_invitation_capacity();

REVOKE ALL ON FUNCTION enforce_group_invitation_capacity() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION enforce_group_invitation_capacity() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION enforce_group_invitation_capacity() FROM authenticated';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. GROUP MESSAGES (text + system activity feed)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ride_group_messages (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id    UUID        NOT NULL REFERENCES ride_groups(id) ON DELETE CASCADE,
  sender_id   UUID        REFERENCES users(id) ON DELETE SET NULL,
  message_type TEXT       NOT NULL DEFAULT 'TEXT'
                          CHECK (message_type IN (
                            'TEXT', 'SYSTEM', 'INVITATION', 'MEMBER',
                            'PICKUP', 'RIDE', 'PAYMENT', 'ROUTE'
                          )),
  content     TEXT        NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ride_group_messages_group_created_idx
  ON ride_group_messages (group_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. VERSIONED ROUTE PLANS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ride_group_route_plans (
  id                    UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id              UUID        NOT NULL REFERENCES ride_groups(id) ON DELETE CASCADE,
  ride_id               UUID        REFERENCES rides(id) ON DELETE CASCADE,
  phase                 TEXT        NOT NULL DEFAULT 'ESTIMATE'
                                    CHECK (phase IN ('ESTIMATE', 'BOOKING', 'DRIVER')),
  version               INTEGER     NOT NULL DEFAULT 1,
  origin_lat            DOUBLE PRECISION,
  origin_lng            DOUBLE PRECISION,
  destination_lat       DOUBLE PRECISION NOT NULL,
  destination_lng       DOUBLE PRECISION NOT NULL,
  destination_address   TEXT,
  stops                 JSONB       NOT NULL DEFAULT '[]',
  total_distance_meters INTEGER     NOT NULL DEFAULT 0,
  total_duration_seconds INTEGER    NOT NULL DEFAULT 0,
  engine                TEXT        NOT NULL DEFAULT 'GoogleRoutes',
  provider_ref          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ride_group_route_plans_version_uniq UNIQUE (group_id, version)
);

CREATE INDEX IF NOT EXISTS ride_group_route_plans_group_created_idx
  ON ride_group_route_plans (group_id, version DESC);
CREATE INDEX IF NOT EXISTS ride_group_route_plans_ride_idx
  ON ride_group_route_plans (ride_id);

-- ---------------------------------------------------------------------------
-- 6. VERSIONED QUOTES + PER-PARTICIPANT SHARES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ride_group_quotes (
  id                    UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id              UUID        NOT NULL REFERENCES ride_groups(id) ON DELETE CASCADE,
  version               INTEGER     NOT NULL,
  status                TEXT        NOT NULL DEFAULT 'ACTIVE'
                                    CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'EXPIRED', 'CONSUMED')),
  route_plan_id         UUID        NOT NULL REFERENCES ride_group_route_plans(id) ON DELETE RESTRICT,
  split_method          TEXT        NOT NULL
                                    CHECK (split_method IN ('HOST_PAYS', 'EQUAL', 'DISTANCE', 'CUSTOM')),
  vehicle_category      TEXT        NOT NULL DEFAULT 'CORE',
  currency              TEXT        NOT NULL DEFAULT 'USD',
  original_fare_cents   BIGINT      NOT NULL CHECK (original_fare_cents >= 0),
  promo_discount_cents  BIGINT      NOT NULL DEFAULT 0 CHECK (promo_discount_cents >= 0),
  discounted_total_cents BIGINT     NOT NULL CHECK (discounted_total_cents >= 0),
  promo_id              UUID        REFERENCES promo_codes(id) ON DELETE SET NULL,
  promo_code            TEXT,
  pickup_snapshot       JSONB       NOT NULL DEFAULT '[]',
  fare_components       JSONB       NOT NULL DEFAULT '{}',
  route_snapshot        JSONB       NOT NULL DEFAULT '{}',
  expires_at            TIMESTAMPTZ NOT NULL,
  created_by            UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ride_group_quotes_version_uniq UNIQUE (group_id, version),
  CONSTRAINT ride_group_quotes_reconcile
    CHECK (discounted_total_cents + promo_discount_cents = original_fare_cents)
);

CREATE INDEX IF NOT EXISTS ride_group_quotes_group_status_idx
  ON ride_group_quotes (group_id, status, version DESC);

CREATE TABLE IF NOT EXISTS ride_group_quote_shares (
  quote_id       UUID        NOT NULL REFERENCES ride_group_quotes(id) ON DELETE CASCADE,
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents   BIGINT      NOT NULL CHECK (amount_cents >= 0),
  distance_meters INTEGER    NOT NULL DEFAULT 0 CHECK (distance_meters >= 0),
  weight         NUMERIC(14, 6) NOT NULL DEFAULT 0,
  required       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (quote_id, user_id)
);

-- ---------------------------------------------------------------------------
-- 7. INDIVIDUAL PAYMENT RECORDS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ride_group_payments (
  id                   UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id             UUID        NOT NULL REFERENCES ride_groups(id) ON DELETE CASCADE,
  quote_id             UUID        NOT NULL REFERENCES ride_group_quotes(id) ON DELETE CASCADE,
  participant_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents         BIGINT      NOT NULL CHECK (amount_cents >= 0),
  currency             TEXT        NOT NULL DEFAULT 'USD',
  status               TEXT        NOT NULL DEFAULT 'PENDING'
                                   CHECK (status IN (
                                     'NOT_REQUIRED', 'PENDING', 'PROCESSING',
                                     'SUCCEEDED', 'FAILED', 'REFUNDED', 'CANCELLED'
                                   )),
  method               TEXT        NOT NULL DEFAULT 'CARD'
                                   CHECK (method IN ('NONE', 'CARD', 'CREDITS', 'MIXED')),
  stripe_payment_id    UUID        REFERENCES stripe_payments(id) ON DELETE SET NULL,
  stripe_payment_intent_id TEXT,
  credit_transaction_id UUID       REFERENCES credit_transactions(id) ON DELETE SET NULL,
  credit_cents         BIGINT      NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  card_cents           BIGINT      NOT NULL DEFAULT 0 CHECK (card_cents >= 0),
  attempt_count        INTEGER     NOT NULL DEFAULT 0,
  failure_reason       TEXT,
  succeeded_at         TIMESTAMPTZ,
  refunded_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ride_group_payments_quote_participant_uniq UNIQUE (quote_id, participant_id),
  CONSTRAINT ride_group_payments_reconcile CHECK (credit_cents + card_cents <= amount_cents)
);

CREATE INDEX IF NOT EXISTS ride_group_payments_group_status_idx
  ON ride_group_payments (group_id, status);
CREATE INDEX IF NOT EXISTS ride_group_payments_participant_idx
  ON ride_group_payments (participant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 8. RIDES INTEGRATION
-- ---------------------------------------------------------------------------
ALTER TABLE rides ADD COLUMN IF NOT EXISTS group_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rides_group_id_fkey'
  ) THEN
    ALTER TABLE rides
      ADD CONSTRAINT rides_group_id_fkey
      FOREIGN KEY (group_id) REFERENCES ride_groups(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS rides_group_idx ON rides (group_id, created_at DESC);

-- A group can only have one non-terminal ride at a time. This is the
-- database-level duplicate-booking guard; the request transaction also locks
-- the group row and uses a ride-level idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS rides_one_active_group_ride_uniq
  ON rides (group_id)
  WHERE group_id IS NOT NULL AND status NOT IN ('COMPLETED', 'CANCELLED');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ride_groups_active_ride_fkey'
  ) THEN
    ALTER TABLE ride_groups
      ADD CONSTRAINT ride_groups_active_ride_fkey
      FOREIGN KEY (active_ride_id) REFERENCES rides(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ride_groups_current_quote_fkey'
  ) THEN
    ALTER TABLE ride_groups
      ADD CONSTRAINT ride_groups_current_quote_fkey
      FOREIGN KEY (current_quote_id) REFERENCES ride_group_quotes(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ride_groups_active_ride_uniq
  ON ride_groups (active_ride_id)
  WHERE active_ride_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 9. RATINGS: one review PER PARTICIPANT (not one per ride)
-- ---------------------------------------------------------------------------
ALTER TABLE ratings DROP CONSTRAINT IF EXISTS ratings_ride_id_key;

-- Robustly remove ANY single-column unique constraint/index on ride_id,
-- regardless of the name Prisma originally generated. Keeping it would
-- prevent a second group participant from reviewing the same shared ride.
DO $$
DECLARE
  c RECORD;
  ride_attnum SMALLINT;
BEGIN
  SELECT attnum INTO ride_attnum
    FROM pg_attribute
   WHERE attrelid = 'ratings'::regclass AND attname = 'ride_id';

  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'ratings'::regclass
       AND contype = 'u'
       AND conkey = ARRAY[ride_attnum]
  LOOP
    EXECUTE format('ALTER TABLE ratings DROP CONSTRAINT %I', c.conname);
  END LOOP;

  FOR c IN
    SELECT indexname
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'ratings'
       AND indexdef LIKE '%UNIQUE%'
       AND indexdef LIKE '%(ride_id)%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', c.indexname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ratings_ride_rater_uniq'
  ) THEN
    ALTER TABLE ratings
      ADD CONSTRAINT ratings_ride_rater_uniq UNIQUE (ride_id, rater_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ratings_rater_idx ON ratings (rater_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 10. RLS / GRANT HARDENING (application tables only)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
  new_tables TEXT[] := ARRAY[
    'friendships',
    'ride_group_settings',
    'ride_groups',
    'ride_group_members',
    'ride_group_invitations',
    'ride_group_messages',
    'ride_group_route_plans',
    'ride_group_quotes',
    'ride_group_quote_shares',
    'ride_group_payments'
  ];
  r TEXT;
BEGIN
  FOREACH t IN ARRAY new_tables LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I', t, r);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- No permissive policies are created: NetRide's JWT is not a Supabase Auth
-- session and every group operation is authorized in the backend service
-- layer. RLS remains the deny-all backstop for any leaked Data API grant.
-- PostGIS' spatial_ref_sys is intentionally not modified here.
