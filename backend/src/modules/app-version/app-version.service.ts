import { pool } from '../../config/database';
import { redis } from '../../config/redis';
import { AuditEventsService } from '../../services/audit-events.service';
import {
  AdminAppUpdateConfig,
  AppId,
  AppPlatform,
  AppReleaseConfig,
  AppUpdateDraft,
  AppUpdateFields,
  APP_IDS,
  APP_PLATFORMS,
  DEFAULT_POPUP_BUTTON,
  DEFAULT_POPUP_MESSAGE,
  DEFAULT_POPUP_TITLE,
  DEFAULT_RELEASE_CONFIGS,
  configKey,
  isAccentColor,
  isCampaignStatus,
  normalizeDraftConfig,
} from './app-version.utils';
import {
  createDraftFieldsSchema,
  toDraftFields,
} from './app-update.validation';

const REDIS_KEY_PREFIX = 'app-release-config:';
const REDIS_CACHE_TTL_S = 30;
const LOCAL_CACHE_TTL_MS = 15_000;

const LOCAL_CACHE_MAX_ENTRIES = 8;

type LocalCache = Map<string, { config: AppReleaseConfig; loadedAt: number }>;

let localCache: LocalCache = new Map();
let warnedAboutMissingTable = false;

export class AppUpdateSchemaMissingError extends Error {
  constructor() {
    super('The app update schema is not available.');
    this.name = 'AppUpdateSchemaMissingError';
  }
}

export class AppUpdateNotFoundError extends Error {
  constructor() {
    super('App update configuration not found.');
    this.name = 'AppUpdateNotFoundError';
  }
}

export class AppUpdateConflictError extends Error {
  constructor(public readonly currentRevision: number) {
    super('The draft changed since it was loaded.');
    this.name = 'AppUpdateConflictError';
  }
}

export class AppUpdateNoDraftError extends Error {
  constructor() {
    super('Save a draft before publishing.');
    this.name = 'AppUpdateNoDraftError';
  }
}

export class AppUpdateInvalidDraftError extends Error {
  constructor(public readonly details: unknown) {
    super('The saved draft is invalid.');
    this.name = 'AppUpdateInvalidDraftError';
  }
}

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isMissingSchema(error: any): boolean {
  return error?.code === '42P01' || error?.code === '42703';
}

function redisKey(app: AppId, platform: AppPlatform): string {
  return `${REDIS_KEY_PREFIX}${configKey(app, platform)}`;
}

function mapRow(row: any): AppReleaseConfig {
  const app = row.app as AppId;
  const platform = row.platform as AppPlatform;
  const fallback = DEFAULT_RELEASE_CONFIGS[app]?.[platform] ??
    DEFAULT_RELEASE_CONFIGS.rider.android;
  return {
    app,
    platform,
    campaignName: row.campaign_name ?? fallback.campaignName,
    latestVersion: row.latest_version,
    minimumVersion: row.minimum_version,
    latestBuild:
      row.latest_build === null || row.latest_build === undefined
        ? null
        : Number(row.latest_build),
    minimumBuild:
      row.minimum_build === null || row.minimum_build === undefined
        ? null
        : Number(row.minimum_build),
    storeUrl: row.store_url ?? '',
    popupTitle: row.popup_title ?? DEFAULT_POPUP_TITLE,
    popupMessage: row.popup_message ?? DEFAULT_POPUP_MESSAGE,
    buttonText: row.button_text ?? DEFAULT_POPUP_BUTTON,
    supportingText: row.supporting_text ?? null,
    announcementLabel: row.announcement_label ?? null,
    accentColor: isAccentColor(row.accent_color) ? row.accent_color : null,
    releaseNotes: row.release_notes ?? null,
    isActive: row.is_active !== false,
    campaignStatus: isCampaignStatus(row.campaign_status)
      ? row.campaign_status
      : 'PUBLISHED',
    publishedAt: toIsoString(row.published_at) ?? toIsoString(row.updated_at),
    publishedBy: row.published_by ?? null,
    publishedByName: row.published_by_name ?? null,
    updatedBy: row.updated_by ?? null,
    updatedByName: row.updated_by_name ?? null,
    updatedAt: toIsoString(row.updated_at),
    draftRevision: Number(row.draft_revision ?? 0),
    source: 'database',
  };
}

function mapDraft(
  row: any,
  published: AppReleaseConfig,
): AppUpdateDraft | null {
  const fields = normalizeDraftConfig(row.draft_config, published);
  if (!fields) return null;
  return {
    ...fields,
    revision: Number(row.draft_revision ?? 0),
    updatedAt: toIsoString(row.draft_updated_at),
    updatedBy: row.draft_updated_by ?? null,
    updatedByName: row.draft_updated_by_name ?? null,
  };
}

function defaultAdminConfig(
  app: AppId,
  platform: AppPlatform,
): AdminAppUpdateConfig {
  return {
    app,
    platform,
    published: { ...DEFAULT_RELEASE_CONFIGS[app][platform] },
    draft: null,
    draftRevision: 0,
    source: 'default',
  };
}

const EXTENDED_SELECT = `
  SELECT c.*,
         pu.full_name AS published_by_name,
         uu.full_name AS updated_by_name,
         du.full_name AS draft_updated_by_name
    FROM app_release_configs c
    LEFT JOIN users pu ON pu.id = c.published_by
    LEFT JOIN users uu ON uu.id = c.updated_by
    LEFT JOIN users du ON du.id = c.draft_updated_by
`;

const LEGACY_SELECT = `
  SELECT c.app, c.platform, c.latest_version, c.minimum_version,
         c.latest_build, c.minimum_build, c.store_url, c.release_notes,
         c.is_active, c.updated_by, c.updated_at, u.full_name AS updated_by_name
    FROM app_release_configs c
    LEFT JOIN users u ON u.id = c.updated_by
`;

async function queryExtendedOne(
  app: AppId,
  platform: AppPlatform,
): Promise<any | null> {
  try {
    const result = await pool.query(
      `${EXTENDED_SELECT} WHERE c.app = $1 AND c.platform = $2`,
      [app, platform],
    );
    return result.rows[0] ?? null;
  } catch (error: any) {
    if (isMissingSchema(error)) throw new AppUpdateSchemaMissingError();
    throw error;
  }
}

async function queryExtendedAll(): Promise<any[]> {
  try {
    const result = await pool.query(EXTENDED_SELECT);
    return result.rows;
  } catch (error: any) {
    if (isMissingSchema(error)) throw new AppUpdateSchemaMissingError();
    throw error;
  }
}

async function loadPublishedFromDb(
  app: AppId,
  platform: AppPlatform,
): Promise<AppReleaseConfig> {
  try {
    const result = await pool.query(
      `${EXTENDED_SELECT} WHERE c.app = $1 AND c.platform = $2`,
      [app, platform],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : { ...DEFAULT_RELEASE_CONFIGS[app][platform] };
  } catch (error: any) {
    if (isMissingSchema(error)) {
      try {
        const legacy = await pool.query(
          `${LEGACY_SELECT} WHERE c.app = $1 AND c.platform = $2`,
          [app, platform],
        );
        const row = legacy.rows[0];
        return row
          ? mapRow(row)
          : { ...DEFAULT_RELEASE_CONFIGS[app][platform] };
      } catch (legacyError: any) {
        if (legacyError?.code !== '42P01') {
          console.error(
            `[APP-VERSION] Failed to load release config: ${legacyError.message}`,
          );
        } else if (!warnedAboutMissingTable) {
          warnedAboutMissingTable = true;
          console.warn(
            '[APP-VERSION] app_release_configs table is missing; serving built-in release defaults.',
          );
        }
        return {
          ...DEFAULT_RELEASE_CONFIGS[app][platform],
          campaignStatus: 'DISABLED',
        };
      }
    }
    console.error(
      `[APP-VERSION] Failed to load release config: ${error.message}`,
    );
    return {
      ...DEFAULT_RELEASE_CONFIGS[app][platform],
      campaignStatus: 'DISABLED',
    };
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
          const config = {
            ...DEFAULT_RELEASE_CONFIGS[app][platform],
            ...parsed,
            app,
            platform,
            source: 'database' as const,
          };
          if (!isCampaignStatus(config.campaignStatus)) {
            config.campaignStatus = 'DISABLED';
          }
          return config;
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

export async function invalidateReleaseCache(
  app: AppId,
  platform: AppPlatform,
): Promise<void> {
  localCache.delete(configKey(app, platform));
  try {
    await redis.del(redisKey(app, platform));
  } catch (error: any) {
    console.error(
      `[APP-VERSION] Redis cache invalidation failed: ${error.message}`,
    );
  }
}

export async function listAdminUpdateConfigs(): Promise<
  AdminAppUpdateConfig[]
> {
  const rows = await queryExtendedAll();
  const byKey = new Map<string, any>();
  for (const row of rows) {
    if (
      (APP_IDS as readonly string[]).includes(row.app) &&
      (APP_PLATFORMS as readonly string[]).includes(row.platform)
    ) {
      byKey.set(configKey(row.app, row.platform), row);
    }
  }

  const configs: AdminAppUpdateConfig[] = [];
  for (const app of APP_IDS) {
    for (const platform of APP_PLATFORMS) {
      const row = byKey.get(configKey(app, platform));
      if (!row) {
        configs.push(defaultAdminConfig(app, platform));
        continue;
      }
      const published = mapRow(row);
      configs.push({
        app,
        platform,
        published,
        draft: mapDraft(row, published),
        draftRevision: published.draftRevision,
        source: 'database',
      });
    }
  }
  return configs;
}

export async function getAdminUpdateConfig(
  app: AppId,
  platform: AppPlatform,
): Promise<AdminAppUpdateConfig> {
  const row = await queryExtendedOne(app, platform);
  if (!row) return defaultAdminConfig(app, platform);
  const published = mapRow(row);
  return {
    app,
    platform,
    published,
    draft: mapDraft(row, published),
    draftRevision: published.draftRevision,
    source: 'database',
  };
}

async function revisionAfterMissingRow(
  app: AppId,
  platform: AppPlatform,
): Promise<number> {
  const result = await pool.query(
    'SELECT draft_revision FROM app_release_configs WHERE app = $1 AND platform = $2',
    [app, platform],
  );
  if (!result.rowCount) throw new AppUpdateNotFoundError();
  return Number(result.rows[0].draft_revision ?? 0);
}

export async function saveAdminUpdateDraft(
  app: AppId,
  platform: AppPlatform,
  fields: AppUpdateFields,
  expectedRevision: number,
  adminId: string | null,
): Promise<AdminAppUpdateConfig> {
  let result;
  try {
    result = await pool.query(
      `UPDATE app_release_configs
          SET draft_config = $1::jsonb,
              draft_updated_by = $2,
              draft_updated_at = NOW(),
              draft_revision = draft_revision + 1
        WHERE app = $3 AND platform = $4 AND draft_revision = $5
        RETURNING draft_revision`,
      [
        JSON.stringify(fields),
        adminId,
        app,
        platform,
        expectedRevision,
      ],
    );
  } catch (error: any) {
    if (isMissingSchema(error)) throw new AppUpdateSchemaMissingError();
    throw error;
  }

  if (!result.rowCount) {
    const currentRevision = await revisionAfterMissingRow(app, platform);
    throw new AppUpdateConflictError(currentRevision);
  }

  await AuditEventsService.record({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'APP_UPDATE_DRAFT_SAVED',
    entityType: 'app_update_campaign',
    entityId: configKey(app, platform),
    details: { fields, expectedRevision },
  });

  return getAdminUpdateConfig(app, platform);
}

export async function publishAdminUpdateDraft(
  app: AppId,
  platform: AppPlatform,
  expectedRevision: number,
  adminId: string | null,
): Promise<AdminAppUpdateConfig> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT * FROM app_release_configs WHERE app = $1 AND platform = $2 FOR UPDATE',
      [app, platform],
    );
    if (!current.rowCount) throw new AppUpdateNotFoundError();

    const row = current.rows[0];
    const currentRevision = Number(row.draft_revision ?? 0);
    if (currentRevision !== expectedRevision) {
      throw new AppUpdateConflictError(currentRevision);
    }
    if (!row.draft_config) throw new AppUpdateNoDraftError();

    const parsed = createDraftFieldsSchema(app, platform).safeParse(
      row.draft_config,
    );
    if (!parsed.success) {
      throw new AppUpdateInvalidDraftError(parsed.error.issues);
    }
    const fields = toDraftFields(parsed.data);
    const previousPublished = mapRow(row);

    await client.query(
      `UPDATE app_release_configs
          SET campaign_name = $1,
              latest_version = $2,
              minimum_version = $3,
              latest_build = $4,
              minimum_build = $5,
              store_url = $6,
              popup_title = $7,
              popup_message = $8,
              button_text = $9,
              supporting_text = $10,
              announcement_label = $11,
              accent_color = $12,
              campaign_status = 'PUBLISHED',
              is_active = TRUE,
              published_at = NOW(),
              published_by = $13,
              updated_by = $13,
              updated_at = NOW(),
              draft_config = NULL,
              draft_updated_by = NULL,
              draft_updated_at = NULL,
              draft_revision = draft_revision + 1
        WHERE app = $14 AND platform = $15`,
      [
        fields.campaignName,
        fields.latestVersion,
        fields.minimumVersion,
        fields.latestBuild,
        fields.minimumBuild,
        fields.storeUrl,
        fields.popupTitle,
        fields.popupMessage,
        fields.buttonText,
        fields.supportingText,
        fields.announcementLabel,
        fields.accentColor,
        adminId,
        app,
        platform,
      ],
    );

    await client.query('COMMIT');
    await invalidateReleaseCache(app, platform);

    await AuditEventsService.record({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: 'APP_UPDATE_CAMPAIGN_PUBLISHED',
      entityType: 'app_update_campaign',
      entityId: configKey(app, platform),
      details: {
        previous: {
          latestVersion: previousPublished.latestVersion,
          minimumVersion: previousPublished.minimumVersion,
        },
        published: fields,
        blocksVersionsBelow: fields.minimumVersion,
      },
    });

    return getAdminUpdateConfig(app, platform);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function discardAdminUpdateDraft(
  app: AppId,
  platform: AppPlatform,
  expectedRevision: number,
  adminId: string | null,
): Promise<AdminAppUpdateConfig> {
  let result;
  try {
    result = await pool.query(
      `UPDATE app_release_configs
          SET draft_config = NULL,
              draft_updated_by = NULL,
              draft_updated_at = NULL,
              draft_revision = draft_revision + 1
        WHERE app = $1 AND platform = $2 AND draft_revision = $3
        RETURNING draft_revision`,
      [app, platform, expectedRevision],
    );
  } catch (error: any) {
    if (isMissingSchema(error)) throw new AppUpdateSchemaMissingError();
    throw error;
  }

  if (!result.rowCount) {
    const currentRevision = await revisionAfterMissingRow(app, platform);
    throw new AppUpdateConflictError(currentRevision);
  }

  await AuditEventsService.record({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'APP_UPDATE_DRAFT_DISCARDED',
    entityType: 'app_update_campaign',
    entityId: configKey(app, platform),
    details: { expectedRevision },
  });

  return getAdminUpdateConfig(app, platform);
}

export async function deactivateAdminUpdateCampaign(
  app: AppId,
  platform: AppPlatform,
  expectedRevision: number,
  adminId: string | null,
  reason: string | null,
): Promise<AdminAppUpdateConfig> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT * FROM app_release_configs WHERE app = $1 AND platform = $2 FOR UPDATE',
      [app, platform],
    );
    if (!current.rowCount) throw new AppUpdateNotFoundError();

    const row = current.rows[0];
    const currentRevision = Number(row.draft_revision ?? 0);
    if (currentRevision !== expectedRevision) {
      throw new AppUpdateConflictError(currentRevision);
    }

    if (String(row.campaign_status) !== 'DISABLED') {
      await client.query(
        `UPDATE app_release_configs
            SET campaign_status = 'DISABLED',
                is_active = FALSE,
                updated_by = $1,
                updated_at = NOW(),
                draft_revision = draft_revision + 1
          WHERE app = $2 AND platform = $3`,
        [adminId, app, platform],
      );
      await client.query('COMMIT');
      await invalidateReleaseCache(app, platform);

      await AuditEventsService.record({
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'APP_UPDATE_CAMPAIGN_DEACTIVATED',
        entityType: 'app_update_campaign',
        entityId: configKey(app, platform),
        details: {
          previousStatus: row.campaign_status,
          minimumVersion: row.minimum_version,
          latestVersion: row.latest_version,
          reason,
        },
      });
    } else {
      await client.query('COMMIT');
    }

    return getAdminUpdateConfig(app, platform);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface AppUpdateHistoryEvent {
  id: string;
  action: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  details: unknown;
  createdAt: string | null;
}

export async function listAdminUpdateHistory(
  app: AppId,
  platform: AppPlatform,
  limit = 25,
): Promise<AppUpdateHistoryEvent[]> {
  const result = await pool.query(
    `SELECT e.id, e.action, e.actor_id, e.details, e.created_at,
            u.full_name AS actor_name, u.email AS actor_email
       FROM audit_events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.entity_type = 'app_update_campaign'
        AND e.entity_id = $1
      ORDER BY e.created_at DESC
      LIMIT $2`,
    [configKey(app, platform), limit],
  );

  return result.rows.map(row => ({
    id: row.id,
    action: row.action,
    actorId: row.actor_id ?? null,
    actorName: row.actor_name ?? null,
    actorEmail: row.actor_email ?? null,
    details: row.details ?? {},
    createdAt: toIsoString(row.created_at),
  }));
}
