// backend/src/routing/utils/eta.ts
//
// ETA (Estimated Time of Arrival) calculator for the A* routing engine.
// Computes realistic travel times using road class, speed limits,
// intersection penalties, turn costs, and congestion factors.

import { RoadClass, ROAD_CLASS_SPEEDS } from '../graph/types';

const MPH_TO_MS = 0.44704;

export interface ETAInput {
  distanceMeters: number;
  roadClass: RoadClass;
  speedLimitMph?: number;
  turnCount?: number;
  intersectionCount?: number;
  roundaboutCount?: number;
  timeOfDay?: number;  // 0-23 hour
  dayOfWeek?: number;  // 0-6 (Sun-Sat)
}

export interface ETAResult {
  durationSeconds: number;
  averageSpeedMph: number;
  congestionFactor: number;
  turnPenaltySeconds: number;
  confidence: number;
}

/** Turn penalties by road class (seconds). */
const TURN_PENALTIES: Record<number, number> = {
  [RoadClass.MOTORWAY]: 0,
  [RoadClass.TRUNK]: 2,
  [RoadClass.PRIMARY]: 3,
  [RoadClass.SECONDARY]: 4,
  [RoadClass.TERTIARY]: 5,
  [RoadClass.UNCLASSIFIED]: 5,
  [RoadClass.RESIDENTIAL]: 6,
  [RoadClass.SERVICE]: 7,
  [RoadClass.LIVING_STREET]: 8,
  9: 5,
};

/** Roundabout penalty (seconds). */
const ROUNDABOUT_PENALTY = 8;

/**
 * Calculate ETA based on route characteristics.
 */
export function calculateETA(input: ETAInput): ETAResult {
  const {
    distanceMeters,
    roadClass,
    speedLimitMph,
    turnCount = 0,
    intersectionCount = 0,
    roundaboutCount = 0,
    timeOfDay,
    dayOfWeek,
  } = input;

  // Base speed from road class or speed limit
  const baseSpeedMph = speedLimitMph && speedLimitMph > 0
    ? speedLimitMph
    : ROAD_CLASS_SPEEDS[roadClass] ?? 25;

  // Congestion factor based on time of day
  const congestionFactor = getCongestionFactor(timeOfDay, dayOfWeek);

  // Effective speed (with congestion)
  const effectiveSpeedMph = baseSpeedMph * congestionFactor;
  const effectiveSpeedMs = effectiveSpeedMph * MPH_TO_MS;

  // Base travel time
  let baseDurationSeconds = distanceMeters / effectiveSpeedMs;

  // Turn penalties
  const turnPenalty = TURN_PENALTIES[roadClass] ?? 5;
  const totalTurnPenalty = turnCount * turnPenalty;

  // Intersection penalties (slight slow-down at each intersection)
  const intersectionPenalty = intersectionCount * 1.5;

  // Roundabout penalties
  const roundaboutPenalty = roundaboutCount * ROUNDABOUT_PENALTY;

  const totalDuration = baseDurationSeconds + totalTurnPenalty + intersectionPenalty + roundaboutPenalty;

  return {
    durationSeconds: Math.round(totalDuration * 10) / 10,
    averageSpeedMph: Math.round(effectiveSpeedMph * 10) / 10,
    congestionFactor: Math.round(congestionFactor * 100) / 100,
    turnPenaltySeconds: totalTurnPenalty + intersectionPenalty + roundaboutPenalty,
    confidence: getConfidence(roadClass, speedLimitMph),
  };
}

/**
 * Get congestion multiplier based on time of day and day of week.
 * Returns 1.0 for free-flow, < 1.0 for congested.
 */
function getCongestionFactor(hour?: number, dayOfWeek?: number): number {
  if (hour === undefined) return 1.0;

  // Weekend factor
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  if (isWeekend) {
    if (hour >= 10 && hour <= 16) return 0.85; // moderate weekend traffic
    if (hour >= 17 && hour <= 21) return 0.75; // evening weekend traffic
    return 1.0;
  }

  // Weekday congestion patterns (Los Angeles area)
  if (hour >= 7 && hour <= 9) return 0.55;   // morning rush
  if (hour >= 10 && hour <= 11) return 0.80; // late morning
  if (hour >= 12 && hour <= 13) return 0.70; // lunch
  if (hour >= 14 && hour <= 15) return 0.75; // early afternoon
  if (hour >= 16 && hour <= 18) return 0.50; // evening rush (worst)
  if (hour >= 19 && hour <= 20) return 0.70; // evening
  if (hour >= 21 || hour <= 6) return 1.0;   // night (free flow)
  return 0.80; // default
}

/**
 * Confidence score for the ETA based on available information.
 */
function getConfidence(roadClass: RoadClass, speedLimit?: number): number {
  let confidence = 0.85;
  if (speedLimit && speedLimit > 0) confidence += 0.10;
  if (roadClass <= RoadClass.TERTIARY) confidence += 0.05;
  return Math.min(confidence, 0.99);
}

/**
 * Simple distance-only ETA calculation (for lightweight endpoint).
 * No turn penalties — just distance / speed.
 */
export function simpleETA(distanceMeters: number, roadClass: RoadClass = RoadClass.SECONDARY): number {
  const speedMph = ROAD_CLASS_SPEEDS[roadClass] ?? 25;
  const speedMs = speedMph * MPH_TO_MS;
  return distanceMeters / speedMs;
}
