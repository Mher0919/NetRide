-- backend/migrations/20260819_add_migrations_applied.sql
-- Migration version table so future ops can see exactly which files
-- have been applied (without relying on filename heuristics). All future
-- migrations should be listed here by name in `INSERT`s below their own
-- statements; both run inside the same transaction so a partial apply
-- will roll back the version row too.
--
-- This migration is APPLIED FIRST on every new environment, before
-- the apply script moves on to any other migrations. The applier script
-- (scripts/run-migrations.cjs) reads the version table to decide what
-- to run.

CREATE TABLE IF NOT EXISTS migrations_applied (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT
);

-- Backfill: every migration whose measured DB artefacts are already
-- present at the time of this migration's execution is listed here as
-- already applied. This reflects the state of THIS deploy; running this
-- file does NOT re-execute the prior migrations — it merely records that
-- they have been applied so future migration loops start clean.
INSERT INTO migrations_applied (filename) VALUES
  ('001_initial_schema.sql'),
  ('002_auth_verification.sql'),
  ('003_fix_user_schema.sql'),
  ('004_add_license_back_photo.sql'),
  ('005_add_insurance_registration.sql'),
  ('006_add_is_active_to_users.sql'),
  ('007_add_ratings_and_moving_average.sql'),
  ('008_add_vehicle_models.sql'),
  ('009_admin_and_audit_logs.sql'),
  ('010_add_user_id_photos.sql'),
  ('011_add_password_expiration.sql'),
  ('012_upgrade_ride_schema.sql'),
  ('013_upgrade_vehicle_classes.sql'),
  ('014_add_vehicle_inspection_and_compliance.sql'),
  ('015_add_favorites_scheduling_tipping.sql'),
  ('016_enable_rls_and_policies.sql'),
  ('017_add_pricing_system.sql'),
  ('019_navigation_safety.sql'),
  ('020_profile_changes_wallet_payouts.sql'),
  ('021_scaling_indexes.sql'),
  ('022_onboarding_phone_fields.sql'),
  ('023_driver_phone_separate.sql'),
  ('024_document_resubmissions.sql'),
  ('025_vehicle_submissions.sql'),
  ('026_vehicle_active_and_resubmission.sql'),
  ('027_add_dob_locked.sql'),
  ('028_storage_files.sql'),
  ('029_audit_logs_admin_nullable.sql'),
  ('029_migrate_legacy_file_urls.sql'),
  ('030_user_block_and_rating_flag.sql'),
  ('031_vehicle_classification_and_preferences.sql'),
  ('032_google_routes_cache.sql'),
  ('033_places_search.sql'),
  ('034_ride_routes.sql'),
  ('035_platform_pricing.sql'),
  ('036_pricing_profiles.sql'),
  ('037_partner_promo_referral_credits.sql'),
  ('038_referral_onboarding_device.sql'),
  ('039_rider_wallet.sql'),
  ('040_notifications_heatmap.sql'),
  ('041_revenue_split.sql'),
  ('042_ride_reports_and_cancellation_reasons.sql'),
  ('043_after_trip_tip_credits.sql'),
  ('044_financial_ledger.sql'),
  ('045_regions.sql'),
  ('046_sponsors.sql'),
  ('046a_sponsors_enums.sql'),
  ('20260628_add_ride_messages.sql'),
  ('20260816_add_ride_driver_rejections.sql'),
  ('20260818_add_ride_driver_interaction_types.sql'),
  ('20260819_add_migrations_applied.sql')
ON CONFLICT (filename) DO NOTHING;
