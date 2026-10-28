import { db, type DbTxUnion, isTransaction } from "./db.ts";
import log from "../log.ts";
import { DbError, ErrorType } from "./common.ts";
import { captureTraceContext } from "../telemetry/propagation.ts";
import type { OutboxSnapshot } from "../telemetry/outbox.ts";

type Status = "PENDING" | "FAILED" | "COMPLETED";

export interface IOutboxRepository {
    getPendingEvents(batchSize: number): Promise<PendingEvent[]>;
    createEvent(topic: string, type: string, payload: Record<string, any>): Promise<void>;
    updateCompletedEvent(id: number): Promise<void>;
    updateFailedEvent(id: number, errorMessage: string, retryCount: number, nextRetryAt: Temporal.Instant | null): Promise<void>;
}

export interface PendingEvent {
    createdAt?: Temporal.Instant;
    payload: object;
    id: number;
    type: string;
    topic: string;
    retryCount: number;
    metadata?: unknown;
}

export class OutboxRepository implements IOutboxRepository {
    db: DbTxUnion;

    constructor(db: DbTxUnion) {
        this.db = db;
    }

    // counts for: ready to be sent; waiting for retry time; fully failed events
    // also returns oldest pending task (see if worker has trouble publishing messages)
    async getMetricsSnapshot(): Promise<OutboxSnapshot> {
        const query = db.raw.sql`
            SELECT
                (COUNT(*) FILTER (WHERE status = 'PENDING' AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= NOW())))::integer AS ready,
                (COUNT(*) FILTER (WHERE status = 'PENDING' AND "nextRetryAt" > NOW()))::integer AS delayed,
                (COUNT(*) FILTER (WHERE status = 'FAILED'))::integer AS failed,
                COALESCE(GREATEST(0, EXTRACT(EPOCH FROM NOW() - MIN("createdAt") FILTER (WHERE status = 'PENDING'))), 0)::integer AS age
            FROM outbox WHERE status IN ('PENDING', 'FAILED')
        `.returnsRow({
            ready: db.sql.public.outbox.columns.id,
            delayed: db.sql.public.outbox.columns.id,
            failed: db.sql.public.outbox.columns.id,
            age: db.sql.public.outbox.columns.id,
        }).build();
        const rows = isTransaction(this.db) ? await this.db.query(query) : await this.db.runtime().query(query);
        const row = rows[0];
        return { ready: row.ready, delayed: row.delayed, failed: row.failed, oldestPendingAge: row.age };
    }

    /// ensures that rows are also locked (when in a transaction) to lower the amount of duplicate work
    async getPendingEvents(batchSize: number): Promise<PendingEvent[]> {
        // raw sql builder only exists in the main db object (for whatever reason)
        const query = db.raw.sql`
            SELECT id, type, topic, payload, metadata, "retryCount", "createdAt"
            FROM outbox
            WHERE status = 'PENDING'
                AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= NOW())
            ORDER BY "createdAt" ASC
            LIMIT ${batchSize}
            FOR UPDATE SKIP LOCKED
        `.returnsRow({
            id: db.sql.public.outbox.columns.id,
            type: db.sql.public.outbox.columns.type,
            topic: db.sql.public.outbox.columns.topic,
            payload: db.sql.public.outbox.columns.payload,
            metadata: db.sql.public.outbox.columns.metadata,
            retryCount: db.sql.public.outbox.columns.retryCount,
            createdAt: db.sql.public.outbox.columns.createdAt,
        }).build();

        try {
            const rows = await (async () => {
                if (isTransaction(this.db))
                    return await this.db.query(query);
                else
                    return await this.db.runtime().query(query);
            })();
            return rows.map(row => ({
                ...row,
                payload: row.payload as object,
            }));
        } catch (e) {
            throw new DbError({
                status: ErrorType.Unknown,
                isUserFault: false,
                message: `${e}`
            });
        }
    }

    async createEvent(topic: string, type: string, payload: Record<string, any>) {
        const carrier = captureTraceContext();
        try {
            await this.db.orm.public.Outbox.create({
                topic,
                type,
                payload,
                metadata: carrier.traceparent ? { ...carrier } : null,
            });
        } catch (e) {
            throw new DbError({
                status: ErrorType.Unknown,
                isUserFault: false,
                message: `${e}`
            });
        }
        
    }

    async updateCompletedEvent(id: number) {
        const status: Status = "COMPLETED";
        try {
            await this.db.orm.public.Outbox
                .where({ id })
                .update({
                    status,
                    nextRetryAt: null,
                    errorMessage: null,
                });
        } catch (e) {
            throw new DbError({
                status: ErrorType.Unknown,
                isUserFault: false,
                message: `${e}`
            });
        }
    }

    async updateFailedEvent(id: number, errorMessage: string, retryCount: number, nextRetryAt: Temporal.Instant | null) {
        const status: Status = nextRetryAt === null ? "FAILED" : "PENDING";
        try {
            await this.db.orm.public.Outbox
                .where({ id })
                .update({
                    status,
                    nextRetryAt,
                    retryCount,
                    errorMessage,
                });
        } catch (e) {
            throw new DbError({
                status: ErrorType.Unknown,
                isUserFault: false,
                message: `${e}`
            });
        }
    }
    
}

