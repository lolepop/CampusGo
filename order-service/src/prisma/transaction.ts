import type { Db, Tx } from "./db.ts";
import { withDatabaseOperation } from "../telemetry/database.ts";

/** Business transaction timing; outbox polling uses the original raw transaction instead. */
export function withTracedTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withDatabaseOperation("database.transaction", () => db.transaction(fn));
}
