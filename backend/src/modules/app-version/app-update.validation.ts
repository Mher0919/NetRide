import { z } from 'zod';
import {
  ACCENT_COLORS,
  APP_VERSION_PATTERN,
  AppId,
  AppPlatform,
  AppUpdateFields,
  POPUP_LIMITS,
  compareVersions,
  isAllowedStoreUrl,
} from './app-version.utils';

const MARKUP = /[<>]/;
const LINE_BREAK = /[\r\n]/;

function lineText(max: number, label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} must be ${max} characters or fewer.`)
    .refine(value => !MARKUP.test(value), 'HTML or markup is not allowed.')
    .refine(
      value => !LINE_BREAK.test(value),
      'Line breaks are not allowed here.',
    );
}

function blockText(max: number, label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} must be ${max} characters or fewer.`)
    .refine(value => !MARKUP.test(value), 'HTML or markup is not allowed.');
}

function optionalText(max: number, label: string) {
  return z.preprocess(
    value => (value === undefined || value === '' ? null : value),
    z
      .string()
      .trim()
      .max(max, `${label} must be ${max} characters or fewer.`)
      .refine(value => !MARKUP.test(value), 'HTML or markup is not allowed.')
      .nullable(),
  );
}

function buildNumber() {
  return z.preprocess(
    value => (value === undefined || value === null || value === '' ? null : Number(value)),
    z
      .number()
      .int('Build numbers must be whole numbers.')
      .min(0, 'Build numbers cannot be negative.')
      .max(1_000_000_000, 'Build number is too large.')
      .nullable(),
  );
}

function versionField(label: string) {
  return z
    .string()
    .trim()
    .regex(
      APP_VERSION_PATTERN,
      `${label} must be numeric, for example 2.1.0.`,
    );
}

function baseDraftFieldsSchema(app: AppId, platform: AppPlatform) {
  return z
    .object({
      campaignName: optionalText(
        POPUP_LIMITS.campaignName,
        'Campaign name',
      ),
      latestVersion: versionField('Latest version'),
      minimumVersion: versionField('Minimum version'),
      latestBuild: buildNumber(),
      minimumBuild: buildNumber(),
      storeUrl: z
        .string()
        .trim()
        .min(1, 'Store URL is required.')
        .max(2048, 'Store URL is too long.')
        .refine(
          value => isAllowedStoreUrl(value, app, platform),
          platform === 'android'
            ? 'Use the canonical Google Play listing for this app.'
            : 'Use the canonical Apple App Store listing for this app.',
        ),
      popupTitle: lineText(POPUP_LIMITS.title, 'Popup title'),
      popupMessage: blockText(POPUP_LIMITS.message, 'Popup message'),
      buttonText: lineText(POPUP_LIMITS.buttonText, 'Update button text'),
      supportingText: optionalText(
        POPUP_LIMITS.supportingText,
        'Supporting text',
      ),
      announcementLabel: optionalText(
        POPUP_LIMITS.announcementLabel,
        'Announcement label',
      ),
      accentColor: z.preprocess(
        value => (value === undefined || value === '' ? null : value),
        z.enum(ACCENT_COLORS).nullable(),
      ),
    });
}

function withVersionRules<
  T extends z.ZodType<{ latestVersion: string; minimumVersion: string; latestBuild: number | null; minimumBuild: number | null }>,
>(schema: T) {
  return schema.superRefine((value, ctx) => {
    if (compareVersions(value.minimumVersion, value.latestVersion) > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['minimumVersion'],
        message: 'Minimum version cannot be higher than the latest version.',
      });
    }
    if (
      compareVersions(value.minimumVersion, value.latestVersion) === 0 &&
      value.minimumBuild !== null &&
      value.latestBuild !== null &&
      value.minimumBuild > value.latestBuild
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['minimumBuild'],
        message: 'Minimum build cannot be higher than the latest build.',
      });
    }
  });
}

export function createDraftFieldsSchema(app: AppId, platform: AppPlatform) {
  return withVersionRules(baseDraftFieldsSchema(app, platform));
}

export function createDraftRequestSchema(app: AppId, platform: AppPlatform) {
  return withVersionRules(
    baseDraftFieldsSchema(app, platform).extend({
      expectedRevision: z
        .number()
        .int()
        .min(0, 'A valid draft revision is required.'),
    }),
  );
}

export const deactivateCampaignSchema = z.object({
  expectedRevision: z
    .number()
    .int()
    .min(0, 'A valid draft revision is required.'),
  reason: optionalText(300, 'Reason'),
});

export function toDraftFields(
  value: z.infer<ReturnType<typeof createDraftFieldsSchema>>,
): AppUpdateFields {
  return {
    campaignName: value.campaignName,
    latestVersion: value.latestVersion,
    minimumVersion: value.minimumVersion,
    latestBuild: value.latestBuild,
    minimumBuild: value.minimumBuild,
    storeUrl: value.storeUrl,
    popupTitle: value.popupTitle,
    popupMessage: value.popupMessage,
    buttonText: value.buttonText,
    supportingText: value.supportingText,
    announcementLabel: value.announcementLabel,
    accentColor: value.accentColor,
  };
}
