// AI assistance (26/9/2026): codex
// hooks and proxies genarated as per my design requirements on hooking

import {
    context, isSpanContextValid, SpanStatusCode, trace,
    type Context, type Span, type SpanOptions,
} from "@opentelemetry/api";


const tracer = trace.getTracer("campusgo.order-service");
const failedSpans = new WeakSet<Span>();
const recordedErrors = new WeakMap<Span, Set<unknown>>();

/** Return correlation fields for a valid active span; never create a trace for a log. */
export function traceLogFields(): Record<string, string> {
    const spanContext = trace.getActiveSpan()?.spanContext();
    return spanContext && isSpanContextValid(spanContext) ? {
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
    } : {};
}

/** Mark a failed operation even when it returned normally, for example an HTTP 500. */
export function markSpanError(span: Span | undefined = trace.getActiveSpan()): void {
    if (!span)
        return;
    failedSpans.add(span);
    span.setStatus({ code: SpanStatusCode.ERROR });
}

/** Check failures marked explicitly or recorded by a nested operation. */
export function isSpanError(span: Span): boolean {
    return failedSpans.has(span);
}

/** Record an exception once per span/error identity and mark that span failed. */
export function recordError(error: unknown, span: Span | undefined = trace.getActiveSpan()): void {
    if (!span)
        return;
    const errors = recordedErrors.get(span) ?? new Set<unknown>();
    if (!errors.has(error)) {
        errors.add(error);
        recordedErrors.set(span, errors);
        span.recordException(error instanceof Error ? error : new Error(String(error)));
    }
    markSpanError(span);
}

/** Explicit client errors and unique-constraint rejections are expected; final HTTP 5xx still marks the request failed. */
export const isExpectedDbError = (error: unknown): boolean => isExpectedHttpError(error) ||
    (error as { sqlState?: string } | null)?.sqlState === "23505";

/** Run in a child span, record unexpected throws, preserve the result/error, and always end it. */
export async function withSpan<T>(name: string, options: SpanOptions, fn: (span: Span) => Promise<T>, parent: Context = context.active()): Promise<T> {
    return await tracer.startActiveSpan(name, options, parent, async span => {
        try {
            return await fn(span);
        } catch (error) {
            if (!isExpectedDbError(error))
                recordError(error, span);
            throw error;
        } finally {
            span.end();
        }
    });
}

/** Only explicit client-facing HTTP errors are expected; raw DB/connection failures remain errors. */
function isExpectedHttpError(error: unknown): boolean {
    const status = (error as { status?: unknown } | null)?.status;
    return error instanceof Error && typeof status === "number" && status >= 400 && status < 500;
}
