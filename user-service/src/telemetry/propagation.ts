// AI assistance (26/9/2026): codex
// hooks and proxies genarated as per my design requirements on hooking

import { context, propagation, ROOT_CONTEXT, type Context } from "@opentelemetry/api";

export interface TraceCarrier {
    traceparent?: string;
    tracestate?: string;
}

/** Only propagate trace context, never arbitrary message metadata or baggage. */
export function readTraceCarrier(value: unknown): TraceCarrier {
    const carrier: TraceCarrier = {};
    if (!value || typeof value !== "object" || Array.isArray(value))
        return carrier;
    for (const [name, raw] of Object.entries(value)) {
        const key = name.toLowerCase();
        if (key !== "traceparent" && key !== "tracestate")
            continue;
        const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw;
        if (typeof text === "string" && text.length <= 512)
            carrier[key] = text;
    }
    return carrier;
}

/** Serialize the selected active context for durable storage or AMQP publication. */
export function captureTraceContext(parent: Context = context.active()): TraceCarrier {
    const carrier: Record<string, string> = {};
    propagation.inject(parent, carrier);
    return readTraceCarrier(carrier);
}

/** A delivery must never inherit the broker connection's or a previous delivery's context. */
export function extractTraceContext(carrier: unknown): Context {
    return propagation.extract(ROOT_CONTEXT, readTraceCarrier(carrier));
}
