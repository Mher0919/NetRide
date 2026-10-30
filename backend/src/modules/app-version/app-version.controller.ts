import { Request, Response } from 'express';
import { z } from 'zod';
import { safeParseBounded } from '../../utils/zod-parse';
import { getReleaseConfig } from './app-version.service';
import {
  APP_IDS,
  APP_PLATFORMS,
  evaluateVersion,
  isAllowedStoreUrl,
} from './app-version.utils';

const versionQuerySchema = z.object({
  app: z.enum(APP_IDS),
  platform: z.enum(APP_PLATFORMS),
  currentVersion: z.string().trim().max(64).optional(),
  buildNumber: z.preprocess(
    value =>
      value === undefined || value === null || value === ''
        ? undefined
        : Number(value),
    z.number().int().nonnegative().optional(),
  ),
});

export class AppVersionController {
  static async getVersion(req: Request, res: Response) {
    const parsed = safeParseBounded(versionQuerySchema, req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'A valid app and platform are required.',
      });
    }

    const { app, platform, currentVersion, buildNumber } = parsed.data;

    try {
      const config = await getReleaseConfig(app, platform);
      const enabled = config.isActive;
      const decision =
        enabled && currentVersion
          ? evaluateVersion(config, currentVersion, buildNumber ?? null)
          : { updateRequired: false, updateAvailable: false };
      const storeUrl = isAllowedStoreUrl(config.storeUrl, app, platform)
        ? config.storeUrl
        : '';

      res.set(
        'Cache-Control',
        'public, max-age=30, stale-while-revalidate=120',
      );
      return res.json({
        app: config.app,
        platform: config.platform,
        enabled,
        latest_version: config.latestVersion,
        minimum_version: config.minimumVersion,
        latest_build: config.latestBuild,
        minimum_build: config.minimumBuild,
        store_url: storeUrl,
        update_required: decision.updateRequired,
        update_available: decision.updateAvailable,
      });
    } catch (error: any) {
      console.error(`[APP-VERSION] Version check failed: ${error.message}`);
      return res.status(500).json({
        error: 'Unable to load app version information right now.',
      });
    }
  }
}
