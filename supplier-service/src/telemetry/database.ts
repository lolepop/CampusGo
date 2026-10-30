// AI assistance (26/9/2026): codex
// hooks and proxies genarated as per my design requirements on hooking

import { trace } from "@opentelemetry/api";
import { durationOptions, meter } from "./instruments.ts";
import { isExpectedDbError, withSpan } from "./tracing.ts";

const databaseDuration = meter.createHistogram("campusgo.database.operation.duration", durationOptions);

/** Measure a fixed database operation even without a recording span. Idle polling is excluded by callers. */
export async function withDatabaseMetrics<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    let outcome = "success";
    try {
        return await fn();
    } catch (error) {
        outcome = isExpectedDbError(error) ? "rejected" : "error";
        throw error;
    } finally {
        databaseDuration.record((performance.now() - start) / 1000, { operation, outcome });
    }
}

/** Time a fixed logical query name; trace only within an active request/message/relay. */
export function withDatabaseOperation<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return withDatabaseMetrics(operation, () => trace.getActiveSpan() ?
        withSpan(operation, { attributes: { "db.system.name": "postgresql", "code.function.name": operation } }, fn) : fn());
}
