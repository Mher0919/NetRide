import { pool } from '../../config/database';
import { redis } from '../../config/redis';
import {
  AppId,
  AppPlatform,
  AppReleaseConfig,
  DEFAULT_RELEASE_CONFIGS,
  configKey,
} from './app-version.utils';

const REDIS_KEY_PREFIX = 'app-release-config:';
const REDIS_CACHE_TTL_S = 30;
const LOCAL_CACHE_TTL_MS = 15_000;
const LOCAL_CACHE_MAX_ENTRIES = 8;

type LocalCache = Map<string, { config: AppReleaseConfig; loadedAt: number }>;

let localCache: LocalCache = new Map();
let warnedAboutMissingTable = false;

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function redisKey(app: AppId, platform: AppPlatform): string {
  return `${REDIS_KEY_PREFIX}${configKey(app, platform)}`;
}

function mapRow(row: any): AppReleaseConfig {
  const app = row.app as AppId;
  const platform = row.platform as AppPlatform;
  const fallback =
    DEFAULT_RELEASE_CONFIGS[app]?.[platform] ??
    DEFAULT_RELEASE_CONFIGS.rider.android;

  return {
    app,
    platform,
    latestVersion: row.latest_version ?? fallback.latestVersion,
    minimumVersion: row.minimum_version ?? fallback.minimumVersion,
    latestBuild:
      row.latest_build === null || row.latest_build === undefined
        ? null
        : Number(row.latest_build),
    minimumBuild:
      row.minimum_build === null || row.minimum_build === undefined
        ? null
        : Number(row.minimum_build),
    storeUrl: row.store_url ?? '',
    isActive: row.is_active !== false,
    updatedAt: toIsoString(row.updated_at),
    source: 'database',
  };
}

async function loadPublishedFromDb(
  app: AppId,
  platform: AppPlatform,
): Promise<AppReleaseConfig> {
  try {
    const result = await pool.query(
      `SELECT app, platform, latest_version, minimum_version,
              latest_build, minimum_build, store_url, is_active, updated_at
         FROM app_release_configs
        WHERE app = $1 AND platform = $2`,
      [app, platform],
    );
    const row = result.rows[0];
    return row
      ? mapRow(row)
      : { ...DEFAULT_RELEASE_CONFIGS[app][platform] };
  } catch (error: any) {
    if (error?.code === '42P01') {
      if (!warnedAboutMissingTable) {
        warnedAboutMissingTable = true;
        console.warn(
          '[APP-VERSION] app_release_configs table is missing; app update enforcement is disabled.',
        );
      }
    } else {
      console.error(
        `[APP-VERSION] Failed to load release config: ${error.message}`,
      );
    }
    return { ...DEFAULT_RELEASE_CONFIGS[app][platform] };
  }
}

export async function getReleaseConfig(
  app: AppId,
  platform: AppPlatform,
): Promise<AppReleaseConfig> {
  const key = configKey(app, platform);
  const cacheKey = redisKey(app, platform);

  let redisAvailable = true;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as Partial<AppReleaseConfig>;
        if (parsed?.app === app && parsed?.platform === platform) {
          return {
            ...DEFAULT_RELEASE_CONFIGS[app][platform],
            ...parsed,
            app,
            platform,
            isActive: parsed.isActive === true,
            source: 'database' as const,
          };
        }
      } catch {
        // Corrupt cache entry: fall through to the database.
      }
    }
  } catch {
    redisAvailable = false;
  }

  if (!redisAvailable) {
    const local = localCache.get(key);
    if (local && Date.now() - local.loadedAt < LOCAL_CACHE_TTL_MS) {
      return local.config;
    }
  }

  const config = await loadPublishedFromDb(app, platform);

  if (redisAvailable) {
    try {
      await redis.set(
        cacheKey,
        JSON.stringify(config),
        'EX',
        REDIS_CACHE_TTL_S,
      );
    } catch {
      // Redis became unavailable; the local fallback still protects us.
    }
  }

  if (localCache.size >= LOCAL_CACHE_MAX_ENTRIES) {
    localCache = new Map();
  }
  localCache.set(key, { config, loadedAt: Date.now() });
  return config;
}
