ALTER TABLE IF EXISTS app_release_configs
  ADD COLUMN IF NOT EXISTS campaign_name TEXT,
  ADD COLUMN IF NOT EXISTS popup_title TEXT NOT NULL DEFAULT 'Update required',
  ADD COLUMN IF NOT EXISTS popup_message TEXT NOT NULL DEFAULT 'A required update is ready. Please update to the latest version to continue using NetRide.',
  ADD COLUMN IF NOT EXISTS button_text TEXT NOT NULL DEFAULT 'Update Now',
  ADD COLUMN IF NOT EXISTS supporting_text TEXT,
  ADD COLUMN IF NOT EXISTS announcement_label TEXT,
  ADD COLUMN IF NOT EXISTS accent_color TEXT,
  ADD COLUMN IF NOT EXISTS campaign_status TEXT NOT NULL DEFAULT 'PUBLISHED',
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS draft_config JSONB,
  ADD COLUMN IF NOT EXISTS draft_updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS draft_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS draft_revision INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF to_regclass('public.app_release_configs') IS NOT NULL THEN
    UPDATE app_release_configs
    SET campaign_name = COALESCE(campaign_name, 'NetRide ' || initcap(app) || ' mandatory update'),
        published_at = COALESCE(published_at, updated_at)
    WHERE campaign_name IS NULL OR published_at IS NULL;
  END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE app_release_configs
    ADD CONSTRAINT app_release_configs_campaign_status_check
    CHECK (campaign_status IN ('DRAFT', 'PUBLISHED', 'DISABLED'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE app_release_configs
    ADD CONSTRAINT app_release_configs_accent_color_check
    CHECK (accent_color IS NULL OR accent_color IN ('#42573F', '#5B7760', '#3F5363', '#8A5A12', '#7A3E3E'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE app_release_configs
    ADD CONSTRAINT app_release_configs_draft_config_check
    CHECK (draft_config IS NULL OR jsonb_typeof(draft_config) = 'object');
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE app_release_configs
    ADD CONSTRAINT app_release_configs_draft_revision_check
    CHECK (draft_revision >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE app_release_configs
    ADD CONSTRAINT app_release_configs_popup_copy_check
    CHECK (
      char_length(popup_title) BETWEEN 1 AND 80 AND
      char_length(popup_message) BETWEEN 1 AND 500 AND
      char_length(button_text) BETWEEN 1 AND 30 AND
      (supporting_text IS NULL OR char_length(supporting_text) <= 300) AND
      (announcement_label IS NULL OR char_length(announcement_label) <= 32) AND
      (campaign_name IS NULL OR char_length(campaign_name) <= 80)
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_table THEN NULL;
END $$;
