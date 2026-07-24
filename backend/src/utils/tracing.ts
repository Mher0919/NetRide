// backend/src/utils/tracing.ts
//
// Distributed tracing utilities.
// Provides trace context propagation and span management.

import { AsyncLocalStorage } from 'async_hooks';

// Global async context storage for trace propagation
const traceContext = new AsyncLocalStorage<TraceContext>();

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
  baggage?: Record<string, string>;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
  status: SpanStatus;
}

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes: Record<string, string | number | boolean>;
}

export type SpanStatus = 'OK' | 'ERROR' | 'UNSET';

// Generate random trace/span IDs
function generateId(length: number): string {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================
// Trace context management
// ============================================

export function runWithTraceContext<T>(context: TraceContext, fn: () => T): T {
  return traceContext.run(context, fn);
}

export function getCurrentTraceContext(): TraceContext | undefined {
  return traceContext.getStore();
}

export function getCurrentTraceId(): string | undefined {
  return traceContext.getStore()?.traceId;
}

export function getCurrentSpanId(): string | undefined {
  return traceContext.getStore()?.spanId;
}

export function createChildSpanId(): string {
  return generateId(16);
}

export function createTraceId(): string {
  return generateId(32);
}

// ============================================
// Span management
// ============================================

const activeSpans = new Map<string, Span>();

export function startSpan(name: string, attributes: Record<string, string | number | boolean> = {}): Span {
  const traceContext = getCurrentTraceContext();
  const traceId = traceContext?.traceId || createTraceId();
  const parentSpanId = traceContext?.spanId;
  const spanId = createChildSpanId();
  
  const span: Span = {
    traceId,
    spanId,
    parentSpanId,
    name,
    startTime: Date.now(),
    attributes: { ...attributes },
    events: [],
    status: 'UNSET',
  };
  
  activeSpans.set(spanId, span);
  
  // Update context with new span
  const newContext: TraceContext = {
    traceId,
    spanId,
    parentSpanId,
    sampled: traceContext?.sampled ?? true,
    baggage: traceContext?.baggage,
  };
  
  return span;
}

export function endSpan(span: Span, status: SpanStatus = 'OK', error?: Error): void {
  span.endTime = Date.now();
  span.status = status;
  if (error) {
    span.attributes['error'] = true;
    span.attributes['error.message'] = error.message;
    span.attributes['error.stack'] = error.stack || '';
  }
  activeSpans.delete(span.spanId);
  exportSpan(span);
}

export function addSpanAttribute(spanId: string, key: string, value: string | number | boolean): void {
  const span = activeSpans.get(spanId);
  if (span) {
    span.attributes[key] = value;
  }
}

export function addSpanEvent(spanId: string, name: string, attributes: Record<string, string | number | boolean> = {}): void {
  const span = activeSpans.get(spanId);
  if (span) {
    span.events.push({
      name,
      timestamp: Date.now(),
      attributes,
    });
  }
}

export function setSpanStatus(spanId: string, status: SpanStatus): void {
  const span = activeSpans.get(spanId);
  if (span) {
    span.status = status;
  }
}

// ============================================
// Span export
// ============================================

let spanExporter: (span: Span) => void = (span) => {
  console.debug(`[TRACE] ${span.name} | ${span.traceId}/${span.spanId} | ${span.endTime ? span.endTime - span.startTime : 'running'}ms | ${span.status}`);
};

export function setSpanExporter(fn: (span: Span) => void): void {
  spanExporter = fn;
}

function exportSpan(span: Span): void {
  try {
    spanExporter(span);
  } catch (err) {
    console.error('[TRACE] Span export failed:', err);
  }
}

// ============================================
// Helper for wrapping functions with tracing
// ============================================

export function withTrace<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes: Record<string, string | number | boolean> = {}
): Promise<T> {
  return runWithTraceContext(
    {
      traceId: getCurrentTraceId() || createTraceId(),
      spanId: createChildSpanId(),
      sampled: true,
    },
    async () => {
      const span = startSpan(name, attributes);
      try {
        const result = await fn(span);
        endSpan(span, 'OK');
        return result;
      } catch (error) {
        endSpan(span, 'ERROR', error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }
  );
}

export function traceAsync<T>(
  name: string,
  fn: () => Promise<T>,
  attributes: Record<string, string | number | boolean> = {}
): Promise<T> {
  return withTrace(name, async (span) => {
    return await fn();
  }, attributes);
}

// ============================================
// HTTP header propagation
// ============================================

export const TRACE_HEADER = 'x-trace-id';
export const SPAN_HEADER = 'x-span-id';
export const SAMPLED_HEADER = 'x-sampled';

export function extractTraceContext(headers: Record<string, string | undefined>): TraceContext | null {
  const traceId = headers[TRACE_HEADER] || headers[TRACE_HEADER.toLowerCase()];
  const spanId = headers[SPAN_HEADER] || headers[SPAN_HEADER.toLowerCase()];
  const sampled = headers[SAMPLED_HEADER] || headers[SAMPLED_HEADER.toLowerCase()];
  
  if (!traceId || !spanId) return null;
  
  return {
    traceId,
    spanId,
    sampled: sampled === 'true',
  };
}

export function injectTraceContext(context: TraceContext, headers: Record<string, string>): void {
  headers[TRACE_HEADER] = context.traceId;
  headers[SPAN_HEADER] = context.spanId;
  headers[SAMPLED_HEADER] = context.sampled ? 'true' : 'false';
}

// ============================================
// Baggage propagation
// ============================================

export const BAGGAGE_HEADER = 'baggage';

export function setBaggage(key: string, value: string): void {
  const context = getCurrentTraceContext();
  if (context) {
    context.baggage = context.baggage || {};
    context.baggage[key] = value;
  }
}

export function getBaggage(key: string): string | undefined {
  const context = getCurrentTraceContext();
  return context?.baggage?.[key];
}

export function injectBaggage(headers: Record<string, string>): void {
  const context = getCurrentTraceContext();
  if (context?.baggage && Object.keys(context.baggage).length > 0) {
    headers[BAGGAGE_HEADER] = Object.entries(context.baggage)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join(', ');
  }
}