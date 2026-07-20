// backend/src/observability/metrics.ts
//
// Prometheus metrics for the NetRide backend. Every counter / histogram
// here MUST be cheap to record — these are called from the hot path
// (request log, match log, OSRM call). The registry is the default
// global one so prom-client picks it up via `register.metrics()`.
//
// Naming follows Prometheus conventions: `<unit>_total` for counters,
// `<unit>_seconds` for time histograms, snake_case throughout.

import client from 'prom-client';

export const register = new client.Registry();

// Standard process / node metrics (CPU, RSS, event loop lag, gc).
client.collectDefaultMetrics({ register, prefix: 'netride_' });

// --- HTTP ------------------------------------------------------------------

export const httpRequestsTotal = new client.Counter({
  name: 'netride_http_requests_total',
  help: 'Count of HTTP requests served, labeled by method/route/status.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [register],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: 'netride_http_request_duration_seconds',
  help: 'HTTP request latency in seconds, labeled by method/route/status.',
  labelNames: ['method', 'route', 'status'] as const,
  // 5ms -> 10s, exponential-ish bucketing. Covers cached (~1ms) to
  // cold-prisma (multi-second) paths without exploding cardinality.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// --- Matching / dispatch ---------------------------------------------------

export const matchJobsTotal = new client.Counter({
  name: 'netride_match_jobs_total',
  help: 'Count of ride match jobs enqueued/completed, labeled by outcome.',
  labelNames: ['outcome'] as const, // enqueued | matched | no_drivers | failed
  registers: [register],
});

export const matchJobDurationSeconds = new client.Histogram({
  name: 'netride_match_job_duration_seconds',
  help: 'Wall time to run a match job (candidate search + scoring + dispatch).',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const dispatchFanoutSize = new client.Histogram({
  name: 'netride_dispatch_fanout_size',
  help: 'Number of drivers offered a trip in parallel per dispatch.',
  buckets: [1, 2, 3, 5, 8, 12, 20],
  registers: [register],
});

export const dispatchAcceptOutcomeTotal = new client.Counter({
  name: 'netride_dispatch_accept_outcome_total',
  help: 'Count of dispatch offers, labeled by outcome.',
  labelNames: ['outcome'] as const, // accepted | declined | timeout | cancelled
  registers: [register],
});

// --- OSRM ------------------------------------------------------------------

export const osrmRequestsTotal = new client.Counter({
  name: 'netride_osrm_requests_total',
  help: 'OSRM HTTP calls, labeled by cache hit and engine.',
  labelNames: ['cache', 'engine'] as const, // cache: hit|miss ; engine: osrm|synthetic
  registers: [register],
});

export const osrmRequestDurationSeconds = new client.Histogram({
  name: 'netride_osrm_request_duration_seconds',
  help: 'OSRM call latency in seconds (excludes cache hits).',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

// --- Socket.IO -------------------------------------------------------------

export const socketConnections = new client.Gauge({
  name: 'netride_socket_connections',
  help: 'Currently connected Socket.IO clients, labeled by role.',
  labelNames: ['role'] as const, // driver | rider | admin
  registers: [register],
});

export const socketEventsTotal = new client.Counter({
  name: 'netride_socket_events_total',
  help: 'Socket.IO events received, labeled by event and role.',
  labelNames: ['event', 'role'] as const,
  registers: [register],
});

// --- Routing pipeline ------------------------------------------------------

/** Total routing plan requests, labeled by cache hit and engine. */
export const routingRequestsTotal = new client.Counter({
  name: 'netride_routing_requests_total',
  help: 'Routing plan requests, labeled by cache hit and engine.',
  labelNames: ['cache', 'engine'] as const, // cache: hit|miss ; engine: osrm|geoapify|synthetic|nearby
  registers: [register],
});

/** End-to-end routing pipeline latency (validation + cache + engine + fare). */
export const routingDurationSeconds = new client.Histogram({
  name: 'netride_routing_duration_seconds',
  help: 'End-to-end routing plan latency in seconds.',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

/** Cache lookup latency (Redis GET + nearby geohash fan-out). */
export const routingCacheLookupSeconds = new client.Histogram({
  name: 'netride_routing_cache_lookup_seconds',
  help: 'Routing cache lookup latency in seconds.',
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05],
  registers: [register],
});

/** Routing engine (OSRM/Geoapify) call latency, excludes cache hits. */
export const routingEngineSeconds = new client.Histogram({
  name: 'netride_routing_engine_seconds',
  help: 'Routing engine call latency in seconds.',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

/** Fare calculation latency — should be sub-millisecond. */
export const routingFareSeconds = new client.Histogram({
  name: 'netride_routing_fare_seconds',
  help: 'Fare calculation latency in seconds.',
  buckets: [0.0001, 0.0005, 0.001, 0.0025, 0.005, 0.01],
  registers: [register],
});

/** Count of synthetic fallback routes (engine unreachable). */
export const routingFallbackTotal = new client.Counter({
  name: 'netride_routing_fallback_total',
  help: 'Count of routes served by the synthetic fallback engine.',
  registers: [register],
});

// --- Redis / Postgres health ----------------------------------------------

export const dependencyUp = new client.Gauge({
  name: 'netride_dependency_up',
  help: '1 if the last health probe to this dependency succeeded, 0 otherwise.',
  labelNames: ['dependency'] as const, // redis | postgres | osrm
  registers: [register],
});

// --- Rate limit ------------------------------------------------------------

export const rateLimitedTotal = new client.Counter({
  name: 'netride_rate_limited_total',
  help: 'Count of requests blocked by the rate limiter, labeled by bucket type.',
  labelNames: ['bucket'] as const, // user | ip | socket
  registers: [register],
});
