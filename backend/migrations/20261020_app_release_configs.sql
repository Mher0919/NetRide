CREATE TABLE IF NOT EXISTS app_release_configs (
  app              TEXT        NOT NULL,
  platform         TEXT        NOT NULL,
  latest_version   TEXT        NOT NULL,
  minimum_version  TEXT        NOT NULL,
  latest_build     INTEGER,
  minimum_build    INTEGER,
  store_url        TEXT        NOT NULL DEFAULT '',
  release_notes    TEXT,
  is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app, platform),
  CONSTRAINT app_release_configs_app_check
    CHECK (app IN ('rider', 'driver')),
  CONSTRAINT app_release_configs_platform_check
    CHECK (platform IN ('android', 'ios')),
  CONSTRAINT app_release_configs_latest_version_check
    CHECK (latest_version ~ '^[0-9]+(\.[0-9]+){1,3}$'),
  CONSTRAINT app_release_configs_minimum_version_check
    CHECK (minimum_version ~ '^[0-9]+(\.[0-9]+){1,3}$'),
  CONSTRAINT app_release_configs_builds_check
    CHECK (
      (latest_build IS NULL OR latest_build >= 0) AND
      (minimum_build IS NULL OR minimum_build >= 0)
    )
);

INSERT INTO app_release_configs
  (app, platform, latest_version, minimum_version, latest_build, minimum_build, store_url)
VALUES
  ('rider', 'android', '1.0.0', '1.0.0', 1, 1,
   'https://play.google.com/store/apps/details?id=com.netride.rider.rider_flutter'),
  ('rider', 'ios', '1.0.0', '1.0.0', 1, 1,
   'https://apps.apple.com/us/search?term=NetRide%20Rider'),
  ('driver', 'android', '1.0.0', '1.0.0', 1, 1,
   'https://play.google.com/store/apps/details?id=com.netride.driver.driver_flutter'),
  ('driver', 'ios', '1.0.0', '1.0.0', 1, 1,
   'https://apps.apple.com/us/search?term=NetRide%20Driver')
ON CONFLICT (app, platform) DO NOTHING;
