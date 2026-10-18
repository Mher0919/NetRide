-- 20261016_sponsor_fixture_ledger_backfill.sql
--
-- Narrow, evidence-backed historical backfill: payment-fixture sponsors were
-- created directly by tests/fixtures/seed-payment-fixtures.cjs, which writes
-- an INITIAL_FUNDING ledger row whose reason literally states it is test
-- fixture funding. That explicit database evidence (never a name guess)
-- classifies those rows as test data so the Sponsor section's "Show test
-- accounts" switch hides them by default.
--
-- Rows without this evidence are NOT touched.

UPDATE sponsors s
SET is_test = TRUE
WHERE s.is_test = FALSE
  AND EXISTS (
    SELECT 1 FROM sponsor_ledger_entries sle
    WHERE sle.sponsor_id = s.id
      AND sle.type = 'INITIAL_FUNDING'
      AND sle.reason LIKE 'Test fixture funding%'
  );
