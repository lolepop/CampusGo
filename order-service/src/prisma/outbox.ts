import { withDatabaseOperation } from "../telemetry/database.ts";
import { captureTraceContext } from "../telemetry/propagation.ts";
import type { OutboxSnapshot } from "../telemetry/outbox.ts";
import { withTracedTransaction } from "./transaction.ts";
import { param } from "@prisma/orm-postgres/relational-core/expression";
import { db, type Db, type Tx } from "./db.ts";
import type { OutboxEvent } from "../rabbitmq/events.ts";

/** Adds events to the outbox. Pass the transaction that changes the order so both commit together. */
export const enqueueEvents = async (conn: Db | Tx, events: OutboxEvent[]): Promise<void> => {
    const carrier = captureTraceContext();
    for (const e of events) {
        await withDatabaseOperation("database.Outbox.create", async () => conn.orm.public.Outbox.create({ topic: e.topic, type: e.type, payload: e.payload, metadata: carrier.traceparent ? { ...carrier } : null }));
    }
};

/** For events that are not tied to another change (e.g. refunding a late hold). */
export const enqueueEventsAlone = (events: OutboxEvent[]) =>
    withTracedTransaction(db, tx => enqueueEvents(tx, events));

export interface PendingEvent {
    id: number;
    topic: string;
    type: string;
    payload: unknown;
    retryCount: number;
    createdAt: string;
    metadata: unknown;
}

const rowSpec = {
    id: "pg/int4@1",
    topic: "pg/text@1",
    type: "pg/text@1",
    payload: "pg/json@1",
    retryCount: "pg/int4@1",
    createdAt: "pg/timestamptz-string@1",
    metadata: { codecId: "pg/json@1", nullable: true },
} as const;

/**
 * Oldest unsent events. FOR UPDATE SKIP LOCKED means two order-service instances never pick up
 * the same row, so scaling to more than one instance does not double-publish.
 */
export const fetchPendingEvents = async (tx: Tx, limit: number): Promise<PendingEvent[]> => {
    const plan = db.raw.sql`
        SELECT id, topic, type, payload, "retryCount", "createdAt", metadata
        FROM outbox
        WHERE status = 'PENDING' AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= now())
        ORDER BY "createdAt" ASC, id ASC
        LIMIT ${param(limit, { codecId: "pg/int4@1" })}
        FOR UPDATE SKIP LOCKED
    `.returnsRow(rowSpec).build();
    return await tx.query(plan) as PendingEvent[];
};

export const markEventSent = async (tx: Tx, id: number): Promise<void> => {
    await withDatabaseOperation("database.Outbox.update", async () => tx.orm.public.Outbox.where({ id }).update({ status: "COMPLETED", nextRetryAt: null, errorMessage: null }));
};

/** Keeps the row PENDING and schedules another attempt; money events are never given up on. */
export const markEventFailed = async (
    tx: Tx, id: number, errorMessage: string, retryCount: number, nextRetryAt: string,
): Promise<void> => {
    await withDatabaseOperation("database.Outbox.update", async () => tx.orm.public.Outbox.where({ id }).update({ retryCount, errorMessage, nextRetryAt }));
};

/** Durable state independent of the relay; this service never exhausts retries. */
export const getOutboxSnapshot = async (): Promise<OutboxSnapshot> => {
    const plan = db.raw.sql`
        SELECT
            (COUNT(*) FILTER (WHERE "nextRetryAt" IS NULL OR "nextRetryAt" <= now()))::integer AS ready,
            (COUNT(*) FILTER (WHERE "nextRetryAt" > now()))::integer AS delayed,
            COALESCE(GREATEST(0, EXTRACT(EPOCH FROM now() - MIN("createdAt"))), 0)::integer AS age
        FROM outbox WHERE status = 'PENDING'
    `.returnsRow({ ready: "pg/int4@1", delayed: "pg/int4@1", age: "pg/int4@1" }).build();
    const [row] = await db.runtime().query(plan);
    return { ready: row.ready, delayed: row.delayed, oldestPendingAge: row.age };
};
