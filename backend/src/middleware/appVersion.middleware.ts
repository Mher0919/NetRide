import { NextFunction, Request, Response } from 'express';
import { getReleaseConfig } from '../modules/app-version/app-version.service';
import {
  APP_IDS,
  APP_PLATFORMS,
  AppId,
  AppPlatform,
  evaluateVersion,
  isAllowedStoreUrl,
  isValidVersion,
  parseVersion,
} from '../modules/app-version/app-version.utils';

const EXEMPT_EXACT = new Set([
  '/health',
  '/health/live',
  '/health/ready',
  '/metrics',
  '/api/ping',
  '/api/payments/return',
  '/api/payments/connect/refresh',
  '/api/payments/connect/return',
]);

const EXEMPT_PREFIXES = [
  '/api/auth',
  '/api/app',
  '/api/admin',
  '/api/files',
  '/api/portal',
  '/api/partner',
  '/api/sponsor',
  '/api/upload',
];

export function isExemptFromAppUpdateEnforcement(
  method: string,
  path: string,
): boolean {
  if (method === 'OPTIONS') return true;
  if (!path.startsWith('/api')) return true;
  if (EXEMPT_EXACT.has(path)) return true;
  return EXEMPT_PREFIXES.some(
    prefix => path === prefix || path.startsWith(`${prefix}/`),
  );
}

export interface AppVersionEnforcementDeps {
  getConfig: typeof getReleaseConfig;
}

export function createAppVersionEnforcement(
  deps: AppVersionEnforcementDeps = { getConfig: getReleaseConfig },
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (isExemptFromAppUpdateEnforcement(req.method, req.path)) {
      return next();
    }

    const appHeader = req.header('x-app-id');
    if (!appHeader) return next();

    const appId = appHeader.trim().toLowerCase();
    const platform = String(req.header('x-app-platform') ?? '')
      .trim()
      .toLowerCase();
    const version = String(req.header('x-app-version') ?? '').trim();

    if (!(APP_IDS as readonly string[]).includes(appId)) {
      return res.status(400).json({
        error: 'A valid X-App-Id header is required.',
        code: 'INVALID_APP_ID',
      });
    }
    if (!(APP_PLATFORMS as readonly string[]).includes(platform)) {
      return res.status(400).json({
        error: 'A valid X-App-Platform header is required.',
        code: 'INVALID_APP_PLATFORM',
      });
    }
    if (!version) {
      return res.status(400).json({
        error: 'An X-App-Version header is required.',
        code: 'MISSING_APP_VERSION',
      });
    }
    if (!parseVersion(version)) {
      return next();
    }

    const buildHeader = req.header('x-app-build');
    const buildNumber =
      buildHeader && /^\d+$/.test(buildHeader.trim())
        ? Number(buildHeader.trim())
        : null;

    try {
      const config = await deps.getConfig(
        appId as AppId,
        platform as AppPlatform,
      );

      if (
        !config.isActive ||
        config.campaignStatus !== 'PUBLISHED' ||
        !isValidVersion(config.minimumVersion)
      ) {
        return next();
      }

      const decision = evaluateVersion(config, version, buildNumber);
      if (!decision.updateRequired) return next();

      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Minimum-Supported-Version', config.minimumVersion);
      res.setHeader('X-Latest-Version', config.latestVersion);
      return res.status(426).json({
        error:
          'This version of NetRide is no longer supported. Please update to continue.',
        code: 'APP_UPDATE_REQUIRED',
        minimum_version: config.minimumVersion,
        latest_version: config.latestVersion,
        store_url: isAllowedStoreUrl(
          config.storeUrl,
          config.app,
          config.platform,
        )
          ? config.storeUrl
          : '',
      });
    } catch (error: any) {
      console.error(
        `[APP-VERSION] Enforcement skipped (config unavailable): ${error.message}`,
      );
      return next();
    }
  };
}

export const enforceAppVersion = createAppVersionEnforcement();
