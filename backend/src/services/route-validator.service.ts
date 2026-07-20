import { logger } from '../observability/logger';

const MIN_ROUTE_DISTANCE_M = 10;
const MAX_REASONABLE_DISTANCE_KM = 5000;
const MAX_SNAP_DISTANCE_M = 500;
const MAX_ROUTE_DURATION_HOURS = 72;

export interface ValidationResult {
  valid: boolean;
  issues: string[];
  distanceMeters: number;
  durationSeconds: number;
  snappedDistanceMeters: number;
}

export class RouteValidatorService {
  static validate(
    distanceMeters: number,
    durationSeconds: number,
    snappedDistanceMeters: number,
  ): ValidationResult {
    const issues: string[] = [];

    if (distanceMeters < MIN_ROUTE_DISTANCE_M) {
      issues.push(`Route distance ${distanceMeters}m is below minimum ${MIN_ROUTE_DISTANCE_M}m`);
    }

    const distanceKm = distanceMeters / 1000;
    if (distanceKm > MAX_REASONABLE_DISTANCE_KM) {
      issues.push(`Route distance ${distanceKm}km exceeds maximum ${MAX_REASONABLE_DISTANCE_KM}km`);
    }

    const durationHours = durationSeconds / 3600;
    if (durationHours > MAX_ROUTE_DURATION_HOURS) {
      issues.push(`Route duration ${durationHours}h exceeds maximum ${MAX_ROUTE_DURATION_HOURS}h`);
    }

    if (snappedDistanceMeters > MAX_SNAP_DISTANCE_M) {
      issues.push(`Endpoint snapped ${snappedDistanceMeters}m from original (max ${MAX_SNAP_DISTANCE_M}m)`);
    }

    return {
      valid: issues.length === 0,
      issues,
      distanceMeters,
      durationSeconds,
      snappedDistanceMeters,
    };
  }

  static async validateRouteResult(
    result: { distanceMeters: number; durationSeconds: number },
    originSnapDistanceM: number,
    destSnapDistanceM: number,
  ): Promise<boolean> {
    const validation = this.validate(
      result.distanceMeters,
      result.durationSeconds,
      Math.max(originSnapDistanceM, destSnapDistanceM),
    );

    if (!validation.valid) {
      logger.warn({ issues: validation.issues }, 'route_validation_failed');
      return false;
    }

    return true;
  }
}
