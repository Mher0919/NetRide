import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../../middleware/auth.middleware';
import { safeParseBounded } from '../../utils/zod-parse';
import {
  AppUpdateConflictError,
  AppUpdateInvalidDraftError,
  AppUpdateNoDraftError,
  AppUpdateNotFoundError,
  AppUpdateSchemaMissingError,
  deactivateAdminUpdateCampaign,
  discardAdminUpdateDraft,
  getAdminUpdateConfig,
  listAdminUpdateConfigs,
  listAdminUpdateHistory,
  publishAdminUpdateDraft,
  saveAdminUpdateDraft,
} from './app-version.service';
import {
  APP_IDS,
  APP_PLATFORMS,
  AppId,
  AppPlatform,
} from './app-version.utils';
import {
  createDraftRequestSchema,
  deactivateCampaignSchema,
  toDraftFields,
} from './app-update.validation';

const targetSchema = z.object({
  app: z.enum(APP_IDS),
  platform: z.enum(APP_PLATFORMS),
});

const publishSchema = z.object({
  expectedRevision: z.number().int().min(0),
});

const discardQuerySchema = z.object({
  expectedRevision: z.preprocess(
    value =>
      value === undefined || value === null || value === ''
        ? undefined
        : Number(value),
    z.number().int().min(0),
  ),
});

function targetFromRequest(
  req: AuthRequest,
): { app: AppId; platform: AppPlatform } | null {
  const parsed = safeParseBounded(targetSchema, req.params);
  return parsed.success ? parsed.data : null;
}

function validationDetails(error: z.ZodError) {
  return error.issues.map(issue => ({
    field: issue.path.join('.'),
    message: issue.message,
  }));
}

function fail(
  res: Response,
  error: unknown,
  fallback = 'Failed to update app update settings.',
) {
  if (error instanceof AppUpdateSchemaMissingError) {
    return res.status(503).json({
      error:
        'App update management is not available until the database migration is applied.',
    });
  }
  if (error instanceof AppUpdateNotFoundError) {
    return res.status(404).json({ error: 'App update configuration not found.' });
  }
  if (error instanceof AppUpdateConflictError) {
    return res.status(409).json({
      error:
        'Another administrator changed this campaign. Reload the page and try again.',
      currentRevision: error.currentRevision,
    });
  }
  if (error instanceof AppUpdateNoDraftError) {
    return res.status(400).json({ error: error.message });
  }
  if (error instanceof AppUpdateInvalidDraftError) {
    return res.status(400).json({
      error: 'The saved draft is invalid and cannot be published.',
      details: error.details,
    });
  }
  console.error(`[APP-UPDATE] ${fallback}: ${(error as Error)?.message}`);
  return res.status(500).json({ error: fallback });
}

export class AppUpdateAdminController {
  static async list(_req: AuthRequest, res: Response) {
    try {
      const configs = await listAdminUpdateConfigs();
      res.json({ configs });
    } catch (error) {
      return fail(res, error, 'Failed to load app update settings.');
    }
  }

  static async getOne(req: AuthRequest, res: Response) {
    const target = targetFromRequest(req);
    if (!target) return res.status(400).json({ error: 'Unknown app or platform.' });

    try {
      const config = await getAdminUpdateConfig(target.app, target.platform);
      res.json({ config });
    } catch (error) {
      return fail(res, error, 'Failed to load app update settings.');
    }
  }

  static async saveDraft(req: AuthRequest, res: Response) {
    const target = targetFromRequest(req);
    if (!target) return res.status(400).json({ error: 'Unknown app or platform.' });

    const parsed = safeParseBounded(
      createDraftRequestSchema(target.app, target.platform),
      req.body,
    );
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Check the highlighted fields and try again.',
        details: validationDetails(parsed.error),
      });
    }

    try {
      const config = await saveAdminUpdateDraft(
        target.app,
        target.platform,
        toDraftFields(parsed.data),
        parsed.data.expectedRevision,
        req.user?.id ?? null,
      );
      res.json({ config });
    } catch (error) {
      return fail(res, error, 'Failed to save the draft.');
    }
  }

  static async discardDraft(req: AuthRequest, res: Response) {
    const target = targetFromRequest(req);
    if (!target) return res.status(400).json({ error: 'Unknown app or platform.' });

    const parsed = safeParseBounded(discardQuerySchema, req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'A valid draft revision is required.',
      });
    }

    try {
      const config = await discardAdminUpdateDraft(
        target.app,
        target.platform,
        parsed.data.expectedRevision,
        req.user?.id ?? null,
      );
      res.json({ config });
    } catch (error) {
      return fail(res, error, 'Failed to discard the draft.');
    }
  }

  static async publish(req: AuthRequest, res: Response) {
    const target = targetFromRequest(req);
    if (!target) return res.status(400).json({ error: 'Unknown app or platform.' });

    const parsed = safeParseBounded(publishSchema, req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'A valid draft revision is required.',
      });
    }

    try {
      const config = await publishAdminUpdateDraft(
        target.app,
        target.platform,
        parsed.data.expectedRevision,
        req.user?.id ?? null,
      );
      res.json({ config });
    } catch (error) {
      return fail(res, error, 'Failed to publish the update campaign.');
    }
  }

  static async deactivate(req: AuthRequest, res: Response) {
    const target = targetFromRequest(req);
    if (!target) return res.status(400).json({ error: 'Unknown app or platform.' });

    const parsed = safeParseBounded(deactivateCampaignSchema, req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'A valid draft revision is required.',
        details: validationDetails(parsed.error),
      });
    }

    try {
      const config = await deactivateAdminUpdateCampaign(
        target.app,
        target.platform,
        parsed.data.expectedRevision,
        req.user?.id ?? null,
        parsed.data.reason,
      );
      res.json({ config });
    } catch (error) {
      return fail(res, error, 'Failed to deactivate the update campaign.');
    }
  }

  static async history(req: AuthRequest, res: Response) {
    const target = targetFromRequest(req);
    if (!target) return res.status(400).json({ error: 'Unknown app or platform.' });

    try {
      const events = await listAdminUpdateHistory(
        target.app,
        target.platform,
      );
      res.json({ events });
    } catch (error) {
      return fail(res, error, 'Failed to load app update history.');
    }
  }
}
