import { pool } from '../../config/database';
import {
  APP_IDS,
  APP_PLATFORMS,
  AppId,
  AppPlatform,
  AppReleaseConfig,
  DEFAULT_RELEASE_CONFIGS,
  configKey,
} from './app-version.utils';

const CACHE_TTL_MS = 60_000;

type ReleaseMap = Map<string, AppReleaseConfig>;

let cachedReleases: { rows: ReleaseMap; loadedAt: number } | null = null;
let warnedAboutMissingTable = false;

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function mapRow(row: any): AppReleaseConfig {
  return {
    app: row.app,
    platform: row.platform,
    latestVersion: row.latest_version,
    minimumVersion: row.minimum_version,
    latestBuild: row.latest_build === null ? null : Number(row.latest_build),
    minimumBuild: row.minimum_build === null ? null : Number(row.minimum_build),
    storeUrl: row.store_url ?? '',
    releaseNotes: row.release_notes ?? null,
    isActive: row.is_active !== false,
    updatedBy: row.updated_by ?? null,
    updatedByName: row.updated_by_name ?? null,
    updatedAt: toIsoString(row.updated_at),
    source: 'database',
  };
}

function defaultReleaseMap(): ReleaseMap {
  const map: ReleaseMap = new Map();
  for (const app of APP_IDS) {
    for (const platform of APP_PLATFORMS) {
      map.set(
        configKey(app, platform),
        { ...DEFAULT_RELEASE_CONFIGS[app][platform] },
      );
    }
  }
  return map;
}

function isMissingTable(error: any): boolean {
  return error?.code === '42P01';
}

async function loadReleases(force = false): Promise<ReleaseMap> {
  if (
    !force &&
    cachedReleases &&
    Date.now() - cachedReleases.loadedAt < CACHE_TTL_MS
  ) {
    return cachedReleases.rows;
  }

  const releases = defaultReleaseMap();

  try {
    const result = await pool.query(
      `SELECT c.app, c.platform, c.latest_version, c.minimum_version,
              c.latest_build, c.minimum_build, c.store_url, c.release_notes,
              c.is_active, c.updated_by, c.updated_at, u.full_name AS updated_by_name
         FROM app_release_configs c
         LEFT JOIN users u ON u.id = c.updated_by`,
    );
    for (const row of result.rows) {
      if (
        !(APP_IDS as readonly string[]).includes(row.app) ||
        !(APP_PLATFORMS as readonly string[]).includes(row.platform)
      ) {
        continue;
      }
      const config = mapRow(row);
      releases.set(configKey(config.app, config.platform), config);
    }
  } catch (error: any) {
    if (isMissingTable(error)) {
      if (!warnedAboutMissingTable) {
        warnedAboutMissingTable = true;
        console.warn(
          '[APP-VERSION] app_release_configs table is missing; serving built-in release defaults.',
        );
      }
    } else {
      console.error(
        `[APP-VERSION] Failed to load release config: ${error.message}`,
      );
    }
  }

  cachedReleases = { rows: releases, loadedAt: Date.now() };
  return releases;
}

export async function getReleaseConfig(
  app: AppId,
  platform: AppPlatform,
): Promise<AppReleaseConfig> {
  const releases = await loadReleases();
  return (
    releases.get(configKey(app, platform)) ?? {
      ...DEFAULT_RELEASE_CONFIGS[app][platform],
    }
  );
}

export async function listReleaseConfigs(): Promise<AppReleaseConfig[]> {
  const releases = await loadReleases(true);
  const rows: AppReleaseConfig[] = [];
  for (const app of APP_IDS) {
    for (const platform of APP_PLATFORMS) {
      rows.push(
        releases.get(configKey(app, platform)) ?? {
          ...DEFAULT_RELEASE_CONFIGS[app][platform],
        },
      );
    }
  }
  return rows;
}


