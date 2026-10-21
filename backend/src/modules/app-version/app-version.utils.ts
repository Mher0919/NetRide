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
  releaseNotes: string | null;
  isActive: boolean;
  updatedBy: string | null;
  updatedByName?: string | null;
  updatedAt: string | null;
  source: 'database' | 'default';
}

export interface VersionDecision {
  updateRequired: boolean;
  updateAvailable: boolean;
}

const DEFAULT_STORE_URLS: Record<AppId, Record<AppPlatform, string>> = {
  rider: {
    android:
      'https://play.google.com/store/apps/details?id=com.netride.rider.rider_flutter',
    ios: 'https://apps.apple.com/us/search?term=NetRide%20Rider',
  },
  driver: {
    android:
      'https://play.google.com/store/apps/details?id=com.netride.driver.driver_flutter',
    ios: 'https://apps.apple.com/us/search?term=NetRide%20Driver',
  },
};

export const DEFAULT_RELEASE_CONFIGS: Record<
  AppId,
  Record<AppPlatform, AppReleaseConfig>
> = {
  rider: {
    android: {
      app: 'rider',
      platform: 'android',
      latestVersion: '1.0.0',
      minimumVersion: '1.0.0',
      latestBuild: 1,
      minimumBuild: 1,
      storeUrl: DEFAULT_STORE_URLS.rider.android,
      releaseNotes: null,
      isActive: true,
      updatedBy: null,
      updatedAt: null,
      source: 'default',
    },
    ios: {
      app: 'rider',
      platform: 'ios',
      latestVersion: '1.0.0',
      minimumVersion: '1.0.0',
      latestBuild: 1,
      minimumBuild: 1,
      storeUrl: DEFAULT_STORE_URLS.rider.ios,
      releaseNotes: null,
      isActive: true,
      updatedBy: null,
      updatedAt: null,
      source: 'default',
    },
  },
  driver: {
    android: {
      app: 'driver',
      platform: 'android',
      latestVersion: '1.0.0',
      minimumVersion: '1.0.0',
      latestBuild: 1,
      minimumBuild: 1,
      storeUrl: DEFAULT_STORE_URLS.driver.android,
      releaseNotes: null,
      isActive: true,
      updatedBy: null,
      updatedAt: null,
      source: 'default',
    },
    ios: {
      app: 'driver',
      platform: 'ios',
      latestVersion: '1.0.0',
      minimumVersion: '1.0.0',
      latestBuild: 1,
      minimumBuild: 1,
      storeUrl: DEFAULT_STORE_URLS.driver.ios,
      releaseNotes: null,
      isActive: true,
      updatedBy: null,
      updatedAt: null,
      source: 'default',
    },
  },
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

export function configKey(app: AppId, platform: AppPlatform): string {
  return `${app}:${platform}`;
}
