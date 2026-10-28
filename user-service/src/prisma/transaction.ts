// AI assistance (26/9/2026): codex
// hooks and proxies genarated as per my design requirements on hooking

import type { Db, Tx } from "./db.ts";
import { trace } from "@opentelemetry/api";
import { withDatabaseMetrics } from "../telemetry/database.ts";
import { withSpan } from "../telemetry/tracing.ts";

export function withTracedTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!trace.getActiveSpan())
        return db.transaction(fn);
    return withDatabaseMetrics("database.transaction", () =>
        withSpan("database.transaction", { attributes: { "db.system.name": "postgresql" } }, () => db.transaction(fn)));
}
