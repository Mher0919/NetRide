// backend/src/modules/routing/routing.controller.ts
//
// HTTP surface for the isolated Routing Service. A single POST /plan call
// returns route geometry + ETA + fare together so the rider app can paint
// the map and price in one round trip. Keeps routing concerns out of the
// ride/geospatial controllers.

import { Request, Response } from 'express';
import { z } from 'zod';
import {
  RoutingService,
  PlanResponse,
  parseCoordinates,
  InvalidCoordinatesError,
} from './routing.service';
import { logger } from '../../observability/logger';

const PlanSchema = z.object({
  origin: z.tuple([z.number(), z.number()]),
  destination: z.tuple([z.number(), z.number()]),
});

const GooglePlanSchema = z.object({
  origin: z.tuple([z.number(), z.number()]),
  destination: z.tuple([z.number(), z.number()]),
  originHex: z.string().optional(),
  destHex: z.string().optional(),
});

export class RoutingController {
  static async plan(req: Request, res: Response): Promise<void> {
    try {
      const parsed = PlanSchema.parse(req.body);
      const origin = parseCoordinates(parsed.origin, 'origin');
      const destination = parseCoordinates(parsed.destination, 'destination');

      const plan: PlanResponse = await RoutingService.plan({
        origin,
        destination,
      });

      // Lean payload — only send what the map + fare card need.
      res.json({
        origin: plan.origin,
        destination: plan.destination,
        distanceMeters: plan.distanceMeters,
        durationSeconds: plan.durationSeconds,
        etaSeconds: plan.etaSeconds,
        geometry: plan.geometry,
        confidence: plan.confidence,
        engine: plan.engine,
        cacheHit: plan.cacheHit,
        fare: plan.fare,
        stepsCount: plan.metadata.stepsCount,
      });
    } catch (err: any) {
      if (err instanceof InvalidCoordinatesError) {
        res.status(400).json({ error: err.detail });
        return;
      }
      if (err?.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid request body', detail: err.errors });
        return;
      }
      logger.error({ err: err.message }, 'routing_plan_failed');
      res.status(500).json({ error: 'Routing failed. Please try again.' });
    }
  }

  static async googlePlan(req: Request, res: Response): Promise<void> {
    try {
      const parsed = GooglePlanSchema.parse(req.body);
      const origin = parseCoordinates(parsed.origin, 'origin');
      const destination = parseCoordinates(parsed.destination, 'destination');

      const plan: PlanResponse = await RoutingService.plan({
        origin,
        destination,
      });

      res.json({
        distanceMeters: plan.distanceMeters,
        durationSeconds: plan.durationSeconds,
        etaSeconds: plan.etaSeconds,
        trafficDurationSeconds: plan.durationSeconds,
        originHex: parsed.originHex ?? '',
        destHex: parsed.destHex ?? '',
        polyline: plan.geometry.coordinates,
        engine: plan.engine,
        cacheHit: plan.cacheHit,
        steps: [],
        // Authoritative backend fare — identical object to /plan. Without
        // this the rider picks a route with no price at all (the old
        // behavior that produced blank "$—" fare cards).
        fare: plan.fare,
      });
    } catch (err: any) {
      if (err instanceof InvalidCoordinatesError) {
        res.status(400).json({ error: err.detail });
        return;
      }
      if (err?.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid request body', detail: err.errors });
        return;
      }
      logger.error({ err: err.message }, 'routing_google_plan_failed');
      res.status(500).json({ error: 'Routing failed. Please try again.' });
    }
  }
}
