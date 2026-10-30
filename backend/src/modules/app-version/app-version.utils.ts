export const APP_IDS = ['rider', 'driver'] as const;
export const APP_PLATFORMS = ['android', 'ios'] as const;

export type AppId = (typeof APP_IDS)[number];
export type AppPlatform = (typeof APP_PLATFORMS)[number];

export const APP_VERSION_PATTERN = /^\d+(?:\.\d+){1,3}$/;

export interface AppReleaseConfig {
  app: AppId;
  platform: AppPlatform;
  latestVersion: string;
  minimumVersion: string;
  latestBuild: number | null;
  minimumBuild: number | null;
  storeUrl: string;
  isActive: boolean;
  updatedAt: string | null;
  source: 'database' | 'default';
}

export interface VersionDecision {
  updateRequired: boolean;
  updateAvailable: boolean;
}

const DEFAULT_CONFIG_FIELDS: Omit<
  AppReleaseConfig,
  'app' | 'platform' | 'source'
> = {
  latestVersion: '1.0.0',
  minimumVersion: '1.0.0',
  latestBuild: 1,
  minimumBuild: 1,
  storeUrl: '',
  isActive: false,
  updatedAt: null,
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
      source: 'default',
    },
    ios: {
      ...DEFAULT_CONFIG_FIELDS,
      app: 'rider',
      platform: 'ios',
      source: 'default',
    },
  },
  driver: {
    android: {
      ...DEFAULT_CONFIG_FIELDS,
      app: 'driver',
      platform: 'android',
      source: 'default',
    },
    ios: {
      ...DEFAULT_CONFIG_FIELDS,
      app: 'driver',
      platform: 'ios',
      source: 'default',
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

export function configKey(app: AppId, platform: AppPlatform): string {
  return `${app}:${platform}`;
}
