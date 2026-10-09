-- backend/migrations/051_stripe_enums.sql
--
-- Enum additions for the Stripe payment integration. Kept in their own
-- migration (separate transaction) because Postgres 55P04 forbids using a
-- newly added enum value in the same transaction that added it.
--
--   payout_method += SPECIAL_TOPUP
--     Driver-earnings true-up credit used when a ride completed under the
--     legacy discounted-fare accounting and the special settlement brings
--     the driver up to the commission calculated from the ORIGINAL fare.
--     One per ride (partial unique index created in 052).
--
-- wallet_transactions_type_check += WALLET_TOPUP
--     A real Stripe-funded top-up of the rider's stored-value wallet.

ALTER TYPE payout_method ADD VALUE IF NOT EXISTS 'SPECIAL_TOPUP';

ALTER TABLE wallet_transactions
  DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;

ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_type_check
  CHECK (type IN (
    'ADMIN_GRANT',
    'RIDE_PAYMENT',
    'RIDE_REFUND',
    'ADJUSTMENT',
    'SPONSOR_REWARD',
    'WALLET_TOPUP'
  ));

ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
