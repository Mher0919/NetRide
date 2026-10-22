import type {
  AppUpdateConfig,
  AppUpdateFieldsPayload,
  AppUpdateHistoryEvent,
} from '../api/admin';

export const APP_UPDATE_LIMITS = {
  campaignName: 80,
  title: 80,
  message: 500,
  buttonText: 30,
  supportingText: 300,
  announcementLabel: 32,
} as const;

export const ACCENT_OPTIONS = [
  { value: null, label: 'NetRide green (default)', color: '#5B7760' },
  { value: '#42573F', label: 'Forest', color: '#42573F' },
  { value: '#5B7760', label: 'Sage', color: '#5B7760' },
  { value: '#3F5363', label: 'Slate', color: '#3F5363' },
  { value: '#8A5A12', label: 'Amber', color: '#8A5A12' },
  { value: '#7A3E3E', label: 'Burgundy', color: '#7A3E3E' },
] as const;

export const APP_LABELS: Record<string, string> = {
  rider: 'Rider',
  driver: 'Driver',
};

export const PLATFORM_LABELS: Record<string, string> = {
  android: 'Android',
  ios: 'iOS',
};

export const HISTORY_ACTION_LABELS: Record<string, string> = {
  APP_UPDATE_DRAFT_SAVED: 'Draft saved',
  APP_UPDATE_DRAFT_DISCARDED: 'Draft discarded',
  APP_UPDATE_CAMPAIGN_PUBLISHED: 'Campaign published',
  APP_UPDATE_CAMPAIGN_DEACTIVATED: 'Campaign deactivated',
};

export const VERSION_PATTERN = /^\d+(?:\.\d+){1,3}$/;

const ANDROID_PACKAGES: Record<string, string> = {
  rider: 'com.netride.rider.rider_flutter',
  driver: 'com.netride.driver.driver_flutter',
};

export interface AppUpdateFormValues {
  campaignName: string;
  latestVersion: string;
  minimumVersion: string;
  latestBuild: number | null;
  minimumBuild: number | null;
  storeUrl: string;
  popupTitle: string;
  popupMessage: string;
  buttonText: string;
  supportingText: string;
  announcementLabel: string;
  accentColor: string | null;
}

export function toDraftPayload(
  values: AppUpdateFormValues,
): AppUpdateFieldsPayload {
  return {
    campaignName: values.campaignName.trim() || null,
    latestVersion: values.latestVersion.trim(),
    minimumVersion: values.minimumVersion.trim(),
    latestBuild: values.latestBuild,
    minimumBuild: values.minimumBuild,
    storeUrl: values.storeUrl.trim(),
    popupTitle: values.popupTitle.trim(),
    popupMessage: values.popupMessage.trim(),
    buttonText: values.buttonText.trim(),
    supportingText: values.supportingText.trim() || null,
    announcementLabel: values.announcementLabel.trim() || null,
    accentColor: values.accentColor,
  };
}

export function formFromConfig(config: AppUpdateConfig): AppUpdateFormValues {
  const source = config.draft ?? config.published;
  return {
    campaignName: source.campaignName ?? '',
    latestVersion: source.latestVersion ?? '',
    minimumVersion: source.minimumVersion ?? '',
    latestBuild: source.latestBuild,
    minimumBuild: source.minimumBuild,
    storeUrl: source.storeUrl ?? '',
    popupTitle: source.popupTitle ?? '',
    popupMessage: source.popupMessage ?? '',
    buttonText: source.buttonText ?? '',
    supportingText: source.supportingText ?? '',
    announcementLabel: source.announcementLabel ?? '',
    accentColor: source.accentColor,
  };
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const core = value.trim().split('+')[0].split('-')[0];
    return /^\d+(?:\.\d+){0,3}$/.test(core)
      ? core.split('.').map(Number)
      : null;
  };
  const a = parse(left);
  const b = parse(right);
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

export function isAllowedStoreUrl(
  value: string,
  app: string,
  platform: string,
): boolean {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
      return false;
    }
    const host = url.hostname.toLowerCase();
    if (platform === 'android') {
      return (
        host === 'play.google.com' &&
        url.pathname === '/store/apps/details' &&
        url.searchParams.get('id') === ANDROID_PACKAGES[app]
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

export function validateAppUpdateForm(
  values: AppUpdateFormValues,
  app: string,
  platform: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const hasMarkup = (value: string) => /[<>]/.test(value);

  if (!VERSION_PATTERN.test(values.latestVersion.trim())) {
    errors.latestVersion = 'Use a numeric version such as 2.1.0.';
  }
  if (!VERSION_PATTERN.test(values.minimumVersion.trim())) {
    errors.minimumVersion = 'Use a numeric version such as 2.0.0.';
  }
  const validBuild = (value: number | null) =>
    value === null || (Number.isInteger(value) && value >= 0);
  if (!validBuild(values.latestBuild)) {
    errors.latestBuild = 'Enter a non-negative whole number or leave empty.';
  }
  if (!validBuild(values.minimumBuild)) {
    errors.minimumBuild = 'Enter a non-negative whole number or leave empty.';
  }
  if (!errors.latestVersion && !errors.minimumVersion) {
    if (compareVersions(values.minimumVersion, values.latestVersion) > 0) {
      errors.minimumVersion =
        'Minimum version cannot be higher than the latest version.';
    } else if (
      compareVersions(values.minimumVersion, values.latestVersion) === 0 &&
      values.minimumBuild !== null &&
      values.latestBuild !== null &&
      values.minimumBuild > values.latestBuild
    ) {
      errors.minimumBuild =
        'Minimum build cannot be higher than the latest build.';
    }
  }

  if (!values.storeUrl.trim()) {
    errors.storeUrl = 'Store URL is required.';
  } else if (!isAllowedStoreUrl(values.storeUrl, app, platform)) {
    errors.storeUrl =
      platform === 'android'
        ? 'Use the canonical Google Play listing for this app.'
        : 'Use the canonical Apple App Store listing for this app.';
  }

  if (!values.popupTitle.trim()) {
    errors.popupTitle = 'Popup title is required.';
  } else if (values.popupTitle.trim().length > APP_UPDATE_LIMITS.title) {
    errors.popupTitle = `Use ${APP_UPDATE_LIMITS.title} characters or fewer.`;
  } else if (hasMarkup(values.popupTitle) || /[\r\n]/.test(values.popupTitle)) {
    errors.popupTitle = 'Use plain text without markup or line breaks.';
  }

  if (!values.popupMessage.trim()) {
    errors.popupMessage = 'Popup message is required.';
  } else if (values.popupMessage.trim().length > APP_UPDATE_LIMITS.message) {
    errors.popupMessage = `Use ${APP_UPDATE_LIMITS.message} characters or fewer.`;
  } else if (hasMarkup(values.popupMessage)) {
    errors.popupMessage = 'Use plain text without HTML or markup.';
  }

  if (!values.buttonText.trim()) {
    errors.buttonText = 'Update button text is required.';
  } else if (values.buttonText.trim().length > APP_UPDATE_LIMITS.buttonText) {
    errors.buttonText = `Use ${APP_UPDATE_LIMITS.buttonText} characters or fewer.`;
  } else if (
    hasMarkup(values.buttonText) ||
    /[\r\n]/.test(values.buttonText)
  ) {
    errors.buttonText = 'Use plain text without markup or line breaks.';
  }

  if (
    values.supportingText.trim().length > APP_UPDATE_LIMITS.supportingText
  ) {
    errors.supportingText = `Use ${APP_UPDATE_LIMITS.supportingText} characters or fewer.`;
  } else if (hasMarkup(values.supportingText)) {
    errors.supportingText = 'Use plain text without HTML or markup.';
  }

  if (
    values.announcementLabel.trim().length >
    APP_UPDATE_LIMITS.announcementLabel
  ) {
    errors.announcementLabel = `Use ${APP_UPDATE_LIMITS.announcementLabel} characters or fewer.`;
  } else if (
    hasMarkup(values.announcementLabel) ||
    /[\r\n]/.test(values.announcementLabel)
  ) {
    errors.announcementLabel =
      'Use plain text without markup or line breaks.';
  }

  if (
    values.campaignName.trim().length > APP_UPDATE_LIMITS.campaignName
  ) {
    errors.campaignName = `Use ${APP_UPDATE_LIMITS.campaignName} characters or fewer.`;
  } else if (hasMarkup(values.campaignName)) {
    errors.campaignName = 'Use plain text without HTML or markup.';
  }

  return errors;
}

export function historySummary(event: AppUpdateHistoryEvent): string {
  const details = event.details ?? {};
  const published = details.published as
    | { latestVersion?: string; minimumVersion?: string }
    | undefined;
  if (published?.latestVersion || published?.minimumVersion) {
    return `Latest ${published.latestVersion ?? '—'} · Minimum ${
      published.minimumVersion ?? '—'
    }`;
  }
  const fields = details.fields as
    | { latestVersion?: string; minimumVersion?: string }
    | undefined;
  if (fields?.latestVersion || fields?.minimumVersion) {
    return `Latest ${fields.latestVersion ?? '—'} · Minimum ${
      fields.minimumVersion ?? '—'
    }`;
  }
  if (typeof details.reason === 'string' && details.reason) {
    return details.reason;
  }
  return '';
}
