import { db, type DbTxUnion, isTransaction } from "./db.ts";
import log from "../log.ts";
import { DbError, ErrorType } from "./common.ts";

type Status = "PENDING" | "FAILED" | "COMPLETED";

export interface IOutboxRepository {
    getPendingEvents(batchSize: number): Promise<PendingEvent[]>;
    createEvent(topic: string, type: string, payload: Record<string, any>): Promise<void>;
    updateCompletedEvent(id: number): Promise<void>;
    updateFailedEvent(id: number, errorMessage: string, retryCount: number, nextRetryAt: Temporal.Instant | null): Promise<void>;
}

export interface PendingEvent {
    payload: object;
    id: number;
    type: string;
    topic: string;
    retryCount: number;
}

export class OutboxRepository implements IOutboxRepository {
    db: DbTxUnion;

    constructor(db: DbTxUnion) {
        this.db = db;
    }

    /// ensures that rows are also locked (when in a transaction) to lower the amount of duplicate work
    async getPendingEvents(batchSize: number): Promise<PendingEvent[]> {
        // raw sql builder only exists in the main db object (for whatever reason)
        const query = db.raw.sql`
            SELECT id, type, topic, payload, "retryCount"
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
            retryCount: db.sql.public.outbox.columns.retryCount,
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
        try {
            await this.db.orm.public.Outbox.create({
                topic,
                type,
                payload
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

