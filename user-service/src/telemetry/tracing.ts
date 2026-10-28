// AI assistance (26/9/2026): codex
// hooks and proxies genarated as per my design requirements on hooking

import {
    context, isSpanContextValid, SpanStatusCode, trace,
    type Context, type Span, type SpanOptions,
} from "@opentelemetry/api";
import { DbError } from "../prisma/common.ts";

const tracer = trace.getTracer("campusgo.user-service");
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

/** User-fault database rejections retain their response behavior and are not span failures. */
export const isExpectedDbError = (error: unknown): boolean => error instanceof DbError && error.isUserFault;

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
