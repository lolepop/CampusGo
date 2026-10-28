// AI assistance (26/9/2026): codex
// hooks and proxies genarated as per my design requirements on hooking

import { isSpanContextValid, trace, type Attributes } from "@opentelemetry/api";
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

/** Preserve method binding/results; measure logical repository work, never arguments or SQL parameters. */
export function instrumentRepository<T extends object>(name: string, repository: T): T {
    return new Proxy(repository, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== "function" || property === "constructor")
                return value;
            return (...args: unknown[]) => {
                const parent = trace.getActiveSpan()?.spanContext();
                const hasParent = parent !== undefined && isSpanContextValid(parent);
                // Background outbox polling has dedicated diagnostics instead of per-query metrics/spans.
                if (!hasParent && name === "outbox")
                    return value.apply(target, args);
                const operation = `repository.${name}.${String(property)}`;
                const attributes: Attributes = { "db.system.name": "postgresql", "code.function.name": String(property) };
                return withDatabaseMetrics(operation, () => {
                    if (hasParent)
                        return withSpan(operation, { attributes }, () => value.apply(target, args));
                    return value.apply(target, args);
                });
            };
        },
    });
}
