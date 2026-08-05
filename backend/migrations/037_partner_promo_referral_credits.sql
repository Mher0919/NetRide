-- backend/migrations/037_partner_promo_referral_credits.sql
--
-- PARTNER + PROMO + REFERRAL + RIDE CREDITS ECOSYSTEM
-- ---------------------------------------------------------------------------
-- Adds the four integrated reward subsystems. Every money movement is a
-- BIGINT cents value; financial truth lives ONLY in these tables:
--
--   ride_credit_accounts   per-rider credit balances (single source of truth)
--   credit_transactions    append-only signed ledger (never mutated)
--   partners               business partners (bars, clubs, hotels, ...)
--   promo_codes            partner-owned promo codes + discount rules
--   promo_usage            per-ride promo application ledger
--   partner_commissions    per-ride partner commission accrual
--   referral_codes         per-rider referral code + signed QR payload
--   referral_relationships per-rider referral link (1 per lifetime)
--   referral_rewards       one-time reward grants (idempotency guard)
--   audit_events           generic admin audit for non-user entities
--
-- Views:
--   reward_ledger          referral reward transactions (read-only projection
--                          of credit_transactions — no duplicated finance)
--
-- Idempotency strategy (same pattern as all prior migrations):
--   CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / CREATE OR
--   REPLACE VIEW, so re-running the file is always safe.

-- ===========================================================================
-- 1. PARTNERS
-- ===========================================================================

CREATE TABLE IF NOT EXISTS partners (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                     TEXT        NOT NULL,
  business_type            TEXT        NOT NULL,
  address                  TEXT,
  contact_name             TEXT,
  contact_phone            TEXT,
  contact_email            TEXT,
  -- Commission as a fraction (0.10 = 10%) of the rider's final payment.
  commission_rate          DECIMAL(5, 4) NOT NULL DEFAULT 0.10,
  -- ACTIVE / INACTIVE / ARCHIVED. Only ACTIVE partners earn commissions
  -- and only ACTIVE partners may own active promos.
  status                   TEXT        NOT NULL DEFAULT 'ACTIVE',
  lifetime_earnings_cents  BIGINT      NOT NULL DEFAULT 0,
  pending_earnings_cents   BIGINT      NOT NULL DEFAULT 0,
  paid_earnings_cents      BIGINT      NOT NULL DEFAULT 0,
  total_referred_rides     BIGINT      NOT NULL DEFAULT 0,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_partners_status ON partners (status);
CREATE INDEX IF NOT EXISTS idx_partners_name ON partners (LOWER(name));

-- ===========================================================================
-- 2. PROMO CODES
-- ===========================================================================

CREATE TABLE IF NOT EXISTS promo_codes (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code                  TEXT        NOT NULL UNIQUE,
  partner_id            UUID        REFERENCES partners(id) ON DELETE SET NULL,
  -- PERCENTAGE (discount_value = percent, e.g. 15) or FIXED (dollars, e.g. 5.00).
  discount_type         TEXT        NOT NULL CHECK (discount_type IN ('PERCENTAGE', 'FIXED')),
  discount_value        DECIMAL(10, 2) NOT NULL CHECK (discount_value > 0),
  -- 0 = unlimited uses (hard cap enforced with a row lock at apply time).
  max_uses              INT         NOT NULL DEFAULT 0,
  times_used            INT         NOT NULL DEFAULT 0,
  expires_at            TIMESTAMPTZ,
  active                BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Minimum fare (cents) for the promo to apply.
  min_ride_fare_cents   BIGINT      NOT NULL DEFAULT 0,
  -- Maximum rider discount (cents); 0 = no cap.
  max_discount_cents    BIGINT      NOT NULL DEFAULT 0,
  -- When true, a rider may only redeem this promo on one ride ever.
  single_use_per_rider  BOOLEAN     NOT NULL DEFAULT TRUE,
  usage_rule            TEXT        NOT NULL DEFAULT 'STANDARD',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_codes_partner ON promo_codes (partner_id);
CREATE INDEX IF NOT EXISTS idx_promo_codes_active_expiry ON promo_codes (active, expires_at);

-- ===========================================================================
-- 3. PROMO USAGE  (one row per ride that applies a promo)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS promo_usage (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  promo_id        UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  ride_id         UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  rider_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  discount_cents  BIGINT      NOT NULL CHECK (discount_cents >= 0),
  rider_paid_cents BIGINT     NOT NULL DEFAULT 0,
  -- APPLIED (ride requested) / USED (ride completed) / VOID (cancelled).
  status          TEXT        NOT NULL DEFAULT 'APPLIED',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

-- A rider can only have ONE live usage of a promo at a time (single-use rule
-- plus the "one live ride" guarantee). VOID rows (cancelled rides) are
-- excluded so the rider can retry the promo on a future ride.
CREATE UNIQUE INDEX IF NOT EXISTS uq_promo_usage_live_per_rider
  ON promo_usage (promo_id, rider_id) WHERE status <> 'VOID';

-- A ride can carry at most one promo application (guard against double-spend).
CREATE UNIQUE INDEX IF NOT EXISTS uq_promo_usage_live_ride
  ON promo_usage (ride_id) WHERE status <> 'VOID';

CREATE INDEX IF NOT EXISTS idx_promo_usage_promo ON promo_usage (promo_id, status);
CREATE INDEX IF NOT EXISTS idx_promo_usage_rider ON promo_usage (rider_id, created_at DESC);

-- ===========================================================================
-- 4. RIDE CREDIT ACCOUNTS + LEDGER
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ride_credit_accounts (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_cents        BIGINT      NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  lifetime_earned_cents BIGINT     NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only money ledger. amount_cents is SIGNED (+ earned, - applied).
-- balance_after_cents snapshots the account balance right after this entry.
-- idempotency_key prevents double-posting under retries/concurrency.
CREATE TABLE IF NOT EXISTS credit_transactions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents      BIGINT NOT NULL CHECK (amount_cents <> 0),
  -- REFERRAL_REWARD / ADMIN_GRANT / RIDE_APPLIED / RIDE_REFUND / ADJUSTMENT
  type              TEXT NOT NULL,
  reference_type    TEXT,
  reference_id      UUID,
  ride_id           UUID REFERENCES rides(id) ON DELETE SET NULL,
  description       TEXT,
  balance_after_cents BIGINT NOT NULL,
  idempotency_key   TEXT UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_tx_type ON credit_transactions (type);
CREATE INDEX IF NOT EXISTS idx_credit_tx_ride ON credit_transactions (ride_id);
CREATE INDEX IF NOT EXISTS idx_credit_tx_ref ON credit_transactions (reference_type, reference_id);

-- ===========================================================================
-- 5. PARTNER COMMISSIONS
-- ===========================================================================

CREATE TABLE IF NOT EXISTS partner_commissions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_id          UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  ride_id             UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  promo_id            UUID REFERENCES promo_codes(id) ON DELETE SET NULL,
  promo_code          TEXT NOT NULL,
  ride_price_cents    BIGINT NOT NULL,
  commission_rate     DECIMAL(5, 4) NOT NULL,
  commission_cents    BIGINT NOT NULL,
  -- PENDING / PAID / VOID. VOID = the ride was cancelled/refunded.
  status              TEXT NOT NULL DEFAULT 'PENDING',
  paid_at             TIMESTAMPTZ,
  paid_reference      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One commission per ride — hard idempotency guard.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_commissions_ride ON partner_commissions (ride_id);
CREATE INDEX IF NOT EXISTS idx_partner_comm_partner ON partner_commissions (partner_id, status);
CREATE INDEX IF NOT EXISTS idx_partner_comm_created ON partner_commissions (created_at DESC);

-- ===========================================================================
-- 6. REFERRAL CODES  (one per rider; QR payload signed by the backend)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS referral_codes (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code         TEXT NOT NULL UNIQUE,
  -- Signed payload embedded in the QR: version.type.uid.code.exp.signature
  qr_payload   TEXT NOT NULL,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes (code);

-- ===========================================================================
-- 7. REFERRAL RELATIONSHIPS  (the referral state machine)
-- ===========================================================================
--
-- Status lifecycle (backend-controlled):
--   QR_SCANNED         scan received, validation passed, row created
--   LINKED             relationship permanent (no re-scan ever)
--   FIRST_RIDE_PENDING linked + awaiting the referred rider's 1st ride
--   FIRST_RIDE_COMPLETED first ride done, reward dispatch pending
--   REWARD_GRANTED     both $5 grants posted — terminal, forever

CREATE TABLE IF NOT EXISTS referral_relationships (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  referrer_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status                 TEXT NOT NULL DEFAULT 'LINKED',
  scanned_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_ride_id          UUID REFERENCES rides(id) ON DELETE SET NULL,
  first_ride_completed_at TIMESTAMPTZ,
  reward_granted_at      TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A rider can be referred exactly ONCE — makes self-referral and referrer
-- replacement structurally impossible.
CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_rel_referred ON referral_relationships (referred_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_rel_pair ON referral_relationships (referrer_id, referred_user_id);
CREATE INDEX IF NOT EXISTS idx_referral_rel_referrer ON referral_relationships (referrer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referral_rel_status ON referral_relationships (status);

-- ===========================================================================
-- 8. REFERRAL REWARDS  (one-time, idempotent grant)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS referral_rewards (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- UNIQUE => a relationship can never be rewarded twice, even under
  -- concurrent ride-completion handlers.
  relationship_id   UUID NOT NULL UNIQUE REFERENCES referral_relationships(id) ON DELETE CASCADE,
  referrer_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ride_id           UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  amount_cents      BIGINT NOT NULL DEFAULT 500,
  referrer_tx_id    UUID REFERENCES credit_transactions(id) ON DELETE SET NULL,
  referred_tx_id    UUID REFERENCES credit_transactions(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_rewards_referrer ON referral_rewards (referrer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referral_rewards_referred ON referral_rewards (referred_user_id, created_at DESC);

-- ===========================================================================
-- 9. GENERIC AUDIT EVENTS (admin actions against non-user entities)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS audit_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role  TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  details     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events (actor_id);

-- ===========================================================================
-- 10. RIDES COLUMNS (additive; fare_amount stays the GROSS fare)
-- ===========================================================================

ALTER TABLE rides ADD COLUMN IF NOT EXISTS promo_id UUID REFERENCES promo_codes(id) ON DELETE SET NULL;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS promo_code TEXT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS promo_discount_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS credits_applied_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS final_payment_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS promo_usage_id UUID REFERENCES promo_usage(id) ON DELETE SET NULL;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS credits_refunded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_rides_promo ON rides (promo_id);
CREATE INDEX IF NOT EXISTS idx_rides_final_payment ON rides (final_payment_cents);

-- ===========================================================================
-- 11. REWARD LEDGER VIEW  (read-only projection — no duplicated finance)
-- ===========================================================================

CREATE OR REPLACE VIEW reward_ledger AS
SELECT
  ct.id              AS transaction_id,
  ct.user_id         AS user_id,
  ct.amount_cents    AS amount_cents,
  ct.type            AS type,
  ct.ride_id         AS ride_id,
  ct.description     AS description,
  ct.created_at      AS created_at,
  rr.relationship_id AS relationship_id,
  rr.referrer_id     AS referrer_id,
  rr.referred_user_id AS referred_user_id
FROM credit_transactions ct
LEFT JOIN referral_rewards rr
  ON rr.referrer_tx_id = ct.id OR rr.referred_tx_id = ct.id
WHERE ct.type IN ('REFERRAL_REWARD', 'ADMIN_GRANT');
