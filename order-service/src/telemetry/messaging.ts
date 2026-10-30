// AI assistance (26/9/2026): codex
// hooks and proxies genarated as per my design requirements on hooking

import { context, SpanKind, type Context, type Span } from "@opentelemetry/api";
import { durationOptions, meter } from "./instruments.ts";
import { isSpanError, recordError, withSpan } from "./tracing.ts";

const messagingDuration = meter.createHistogram("campusgo.messaging.operation.duration", durationOptions);

export type MessagingOperation = "publish" | "process" | "rpc.call" | "rpc.process" | "rpc.reply" | "rpc.receive";

/** Trace one messaging operation and measure seconds using only bounded operation/outcome labels. */
export async function withMessagingSpan<T>(operation: MessagingOperation, destination: string, kind: SpanKind, fn: (span: Span) => Promise<T>, parent: Context = context.active()): Promise<T> {
    return await withSpan(`${operation} ${destination}`, {
        kind,
        attributes: {
            "messaging.system": "rabbitmq",
            "messaging.destination.name": destination,
            "messaging.operation.name": operation,
            "messaging.operation.type": operation === "process" || operation === "rpc.process" || operation === "rpc.receive" ? "process" : "send",
        },
    }, async span => {
        const start = performance.now();
        try {
            return await fn(span);
        } catch (error) {
            recordError(error, span);
            throw error;
        } finally {
            messagingDuration.record((performance.now() - start) / 1000, {
                operation,
                outcome: isSpanError(span) ? "error" : "success",
            });
        }
    }, parent);
}
