export const APP_IDS = ['rider', 'driver'] as const;
export const APP_PLATFORMS = ['android', 'ios'] as const;
export const CAMPAIGN_STATUSES = ['DRAFT', 'PUBLISHED', 'DISABLED'] as const;
export const ACCENT_COLORS = [
  '#42573F',
  '#5B7760',
  '#3F5363',
  '#8A5A12',
  '#7A3E3E',
] as const;

export type AppId = (typeof APP_IDS)[number];
export type AppPlatform = (typeof APP_PLATFORMS)[number];
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export type AccentColor = (typeof ACCENT_COLORS)[number];

export const APP_VERSION_PATTERN = /^\d+(?:\.\d+){1,3}$/;

export const POPUP_LIMITS = {
  campaignName: 80,
  title: 80,
  message: 500,
  buttonText: 30,
  supportingText: 300,
  announcementLabel: 32,
} as const;

export const DEFAULT_POPUP_TITLE = 'Update required';
export const DEFAULT_POPUP_MESSAGE =
  'A required update is ready. Please update to the latest version to continue using NetRide.';
export const DEFAULT_POPUP_BUTTON = 'Update Now';

export interface AppUpdateFields {
  campaignName: string | null;
  latestVersion: string;
  minimumVersion: string;
  latestBuild: number | null;
  minimumBuild: number | null;
  storeUrl: string;
  popupTitle: string;
  popupMessage: string;
  buttonText: string;
  supportingText: string | null;
  announcementLabel: string | null;
  accentColor: string | null;
}

export interface AppReleaseConfig extends AppUpdateFields {
  app: AppId;
  platform: AppPlatform;
  releaseNotes: string | null;
  isActive: boolean;
  campaignStatus: CampaignStatus;
  publishedAt: string | null;
  publishedBy: string | null;
  publishedByName?: string | null;
  updatedBy: string | null;
  updatedByName?: string | null;
  updatedAt: string | null;
  draftRevision: number;
  source: 'database' | 'default';
}

export interface AppUpdateDraft extends AppUpdateFields {
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
  updatedByName?: string | null;
}

export interface AdminAppUpdateConfig {
  app: AppId;
  platform: AppPlatform;
  published: AppReleaseConfig;
  draft: AppUpdateDraft | null;
  draftRevision: number;
  source: 'database' | 'default';
}

export interface VersionDecision {
  updateRequired: boolean;
  updateAvailable: boolean;
}

const DEFAULT_CONFIG_FIELDS: AppUpdateFields = {
  campaignName: null,
  latestVersion: '1.0.0',
  minimumVersion: '1.0.0',
  latestBuild: 1,
  minimumBuild: 1,
  storeUrl: '',
  popupTitle: DEFAULT_POPUP_TITLE,
  popupMessage: DEFAULT_POPUP_MESSAGE,
  buttonText: DEFAULT_POPUP_BUTTON,
  supportingText: null,
  announcementLabel: null,
  accentColor: null,
};

export const DEFAULT_RELEASE_CONFIGS: Record<
  AppId,
  Record<AppPlatform, AppReleaseConfig>
> = {
  rider: {
    android: {
      ...DEFAULT_CONFIG_FIELDS,
      app: 'rider',
      platform: 'android',
      releaseNotes: null,
      isActive: true,
      campaignStatus: 'PUBLISHED',
      publishedAt: null,
      publishedBy: null,
      updatedBy: null,
      updatedAt: null,
      draftRevision: 0,
      source: 'default',
      campaignName: 'NetRide Rider mandatory update',
    },
    ios: {
      ...DEFAULT_CONFIG_FIELDS,
      app: 'rider',
      platform: 'ios',
      releaseNotes: null,
      isActive: true,
      campaignStatus: 'PUBLISHED',
      publishedAt: null,
      publishedBy: null,
      updatedBy: null,
      updatedAt: null,
      draftRevision: 0,
      source: 'default',
      campaignName: 'NetRide Rider mandatory update',
    },
  },
  driver: {
    android: {
      ...DEFAULT_CONFIG_FIELDS,
      app: 'driver',
      platform: 'android',
      releaseNotes: null,
      isActive: true,
      campaignStatus: 'PUBLISHED',
      publishedAt: null,
      publishedBy: null,
      updatedBy: null,
      updatedAt: null,
      draftRevision: 0,
      source: 'default',
      campaignName: 'NetRide Driver mandatory update',
    },
    ios: {
      ...DEFAULT_CONFIG_FIELDS,
      app: 'driver',
      platform: 'ios',
      releaseNotes: null,
      isActive: true,
      campaignStatus: 'PUBLISHED',
      publishedAt: null,
      publishedBy: null,
      updatedBy: null,
      updatedAt: null,
      draftRevision: 0,
      source: 'default',
      campaignName: 'NetRide Driver mandatory update',
    },
  },
};

const ANDROID_PACKAGE_BY_APP: Record<AppId, string> = {
  rider: 'com.netride.rider.rider_flutter',
  driver: 'com.netride.driver.driver_flutter',
};

export function isValidVersion(value: string): boolean {
  return APP_VERSION_PATTERN.test(String(value ?? '').trim());
}

export function parseVersion(value: string): number[] | null {
  const core = String(value ?? '')
    .trim()
    .split('+')[0]
    .split('-')[0];
  if (!/^\d+(?:\.\d+){0,3}$/.test(core)) return null;
  return core.split('.').map(part => Number(part));
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;

  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

export function isBelowVersion(
  currentVersion: string,
  currentBuild: number | null,
  targetVersion: string,
  targetBuild: number | null,
): boolean {
  const comparison = compareVersions(currentVersion, targetVersion);
  if (comparison !== 0) return comparison < 0;
  if (targetBuild === null || currentBuild === null) return false;
  return currentBuild < targetBuild;
}

export function evaluateVersion(
  config: Pick<
    AppReleaseConfig,
    'latestVersion' | 'minimumVersion' | 'latestBuild' | 'minimumBuild'
  >,
  currentVersion: string,
  currentBuild: number | null,
): VersionDecision {
  if (!parseVersion(currentVersion)) {
    return { updateRequired: false, updateAvailable: false };
  }

  const updateRequired = isBelowVersion(
    currentVersion,
    currentBuild,
    config.minimumVersion,
    config.minimumBuild,
  );

  const updateAvailable =
    updateRequired ||
    isBelowVersion(
      currentVersion,
      currentBuild,
      config.latestVersion,
      config.latestBuild,
    );

  return { updateRequired, updateAvailable };
}

export function isAllowedStoreUrl(
  value: string,
  app: AppId,
  platform: AppPlatform,
): boolean {
  try {
    const url = new URL(String(value ?? '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
      return false;
    }
    const host = url.hostname.toLowerCase();

    if (platform === 'android') {
      return (
        host === 'play.google.com' &&
        url.pathname === '/store/apps/details' &&
        url.searchParams.get('id') === ANDROID_PACKAGE_BY_APP[app]
      );
    }

    return (
      (host === 'apps.apple.com' || host === 'itunes.apple.com') &&
      /^\/(?:[a-z]{2}\/)?app\//i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function isAccentColor(value: unknown): value is AccentColor {
  return (
    typeof value === 'string' &&
    (ACCENT_COLORS as readonly string[]).includes(value)
  );
}

export function isCampaignStatus(value: unknown): value is CampaignStatus {
  return (
    typeof value === 'string' &&
    (CAMPAIGN_STATUSES as readonly string[]).includes(value)
  );
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asBuild(value: unknown, fallback: number | null): number | null {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function normalizeDraftConfig(
  raw: unknown,
  fallback: AppUpdateFields,
): AppUpdateFields | null {
  if (raw === null || raw === undefined) return null;
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const has = (key: string) =>
    Object.prototype.hasOwnProperty.call(source, key);

  const latestVersion = asString(source.latestVersion, fallback.latestVersion);
  const minimumVersion = asString(
    source.minimumVersion,
    fallback.minimumVersion,
  );

  return {
    campaignName: has('campaignName')
      ? asNullableString(source.campaignName)
      : fallback.campaignName,
    latestVersion: isValidVersion(latestVersion)
      ? latestVersion
      : fallback.latestVersion,
    minimumVersion: isValidVersion(minimumVersion)
      ? minimumVersion
      : fallback.minimumVersion,
    latestBuild: asBuild(source.latestBuild, fallback.latestBuild),
    minimumBuild: asBuild(source.minimumBuild, fallback.minimumBuild),
    storeUrl: asString(source.storeUrl, fallback.storeUrl),
    popupTitle: asString(source.popupTitle, fallback.popupTitle),
    popupMessage: asString(source.popupMessage, fallback.popupMessage),
    buttonText: asString(source.buttonText, fallback.buttonText),
    supportingText: has('supportingText')
      ? asNullableString(source.supportingText)
      : fallback.supportingText,
    announcementLabel: has('announcementLabel')
      ? asNullableString(source.announcementLabel)
      : fallback.announcementLabel,
    accentColor: has('accentColor')
      ? isAccentColor(source.accentColor)
        ? source.accentColor
        : null
      : fallback.accentColor,
  };
}

export function configKey(app: AppId, platform: AppPlatform): string {
  return `${app}:${platform}`;
}
