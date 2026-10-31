-- 20261031_group_tips.sql
--
-- Per-participant tips for group rides.
--
-- Regular rides keep their existing one-tip-per-ride model. A group ride has
-- multiple paying participants, so each participant can independently tip the
-- driver once. Tips are stored in `ride_group_tips` (audit) and credited to the
-- driver's wallet through one TIP_CREDIT payout scoped by a unique reference:
--
--   regular tip: payouts.reference IS NULL          (one per ride)
--   group tip:   payouts.reference = 'group-tip:<user>' (one per participant)
--
-- The unique index is expression-based so a regular ride can still only have
-- one tip credit, while each group participant gets exactly one.

CREATE TABLE IF NOT EXISTS ride_group_tips (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  ride_id     UUID        NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  group_id    UUID        NOT NULL REFERENCES ride_groups(id) ON DELETE CASCADE,
  tipper_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents BIGINT     NOT NULL CHECK (amount_cents > 0),
  status      TEXT        NOT NULL DEFAULT 'RECORDED'
                          CHECK (status IN ('RECORDED', 'CREDITED')),
  payout_id   UUID        REFERENCES payouts(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ride_group_tips_one_per_participant UNIQUE (ride_id, tipper_id)
);

CREATE INDEX IF NOT EXISTS ride_group_tips_ride_idx
  ON ride_group_tips (ride_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ride_group_tips_tipper_idx
  ON ride_group_tips (tipper_id, created_at DESC);

-- Replace the one-per-ride tip uniqueness with one-per-(ride, reference).
-- NULL reference is the legacy/regular-ride tip and remains unique per ride.
DROP INDEX IF EXISTS payouts_tip_credit_unique;
CREATE UNIQUE INDEX IF NOT EXISTS payouts_tip_credit_unique
  ON payouts (ride_id, COALESCE(reference, ''))
  WHERE method = 'TIP_CREDIT';

-- Deny direct client access (the backend owner connection bypasses RLS, as
-- with every other application table).
ALTER TABLE ride_group_tips ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.ride_group_tips FROM %I', r);
    END IF;
  END LOOP;
END $$;
