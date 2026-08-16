-- backend/migrations/046a_sponsors_enums.sql
--
-- Enum extensions for the sponsors/SPECIALS module. These MUST run in their
-- own migration: Postgres forbids using an ALTER TYPE ... ADD VALUE value in
-- the same transaction that added it (error 55P04), and 046 uses
-- 'SPONSOR_CREDIT' in a partial index predicate. Apply 046a BEFORE 046.
--
-- Run: npx ts-node src/scripts/run-migration.ts 046a_sponsors_enums.sql
--      npx ts-node src/scripts/run-migration.ts 046_sponsors.sql

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'SPONSOR';
ALTER TYPE payout_method ADD VALUE IF NOT EXISTS 'SPONSOR_CREDIT';
