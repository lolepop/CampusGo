import log from "../log.ts";
import type { IQueueProvider } from "./provider.ts";
import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import { extractTraceContext } from "../telemetry/propagation.ts";
import { recordError, withSpan } from "../telemetry/tracing.ts";
import { outboxAttempts, outboxBatchFailures, outboxConfirmationDelay, outboxLastPoll, outboxWorkerRunning } from "../telemetry/queue.ts";

export const BATCH_SIZE = 50;
export const MAX_RETRIES = 5;
export const BASE_RETRY_DELAY_MS = 1000;
export const POLL_INTERVAL_MS = 200;
export const ERROR_BACKOFF_MS = 2000;

/** a row pending relay, shaped for the worker's needs. */
export interface OutboxRow {
    readonly createdAt?: Temporal.Instant;
    readonly id: string | number;
    readonly topic: string;
    readonly type: string;
    readonly payload: object;
    readonly retryCount: number;
    readonly metadata?: unknown;
}

export interface IOutboxTx {
    fetchPending(limit: number): Promise<OutboxRow[]>;
    markCompleted(id: OutboxRow["id"]): Promise<void>;
    markFailed(id: OutboxRow["id"], errMsg: string, retryCount: number, nextRetryAt: Temporal.Instant | null): Promise<void>;
}

/** abstraction of the store backing the worker */
export interface IOutboxSource {
    /** run fn where tx is a newly created transaction */
    withTransaction<R>(fn: (tx: IOutboxTx) => Promise<R>): Promise<R>;
}

/// exponential backoff with jitter
const calcExpBackoff = (baseMs: number, newRetryCount: number) =>
    Math.round(baseMs * 2 ** (newRetryCount - 1) * (0.5 + Math.random()));

export class OutboxWorker {
    private source: IOutboxSource;
    private msgQueue: IQueueProvider;

    private running = false;
    private loopPromise: Promise<void> | null = null;
    private sleepCts: (() => void) | null = null;

    constructor(source: IOutboxSource, msgQueue: IQueueProvider) {
        this.source = source;
        this.msgQueue = msgQueue;
    }

    isRunning(): boolean {
        return this.running;
    }

    /** starts execution if not already started */
    start(): void {
        if (this.running) {
            log.warn("OutboxWorker.start() called while already running");
            return;
        }
        this.running = true;
        outboxWorkerRunning.record(1);
        this.loopPromise = context.with(ROOT_CONTEXT, () => this.runLoop()).catch(err => {
            log.error(`OutboxWorker loop crashed: ${err?.stack ?? err}`);
        }).finally(() => {
            outboxWorkerRunning.record(0);
        });
        log.info("OutboxWorker started");
    }

    /** safely stop execution and wait for the current batch to finish. */
    async stop(): Promise<void> {
        if (!this.running)
            return;
        this.running = false;
        outboxWorkerRunning.record(0);
        this.sleepCts?.(); // force wakeup and exit polling loop

        log.info("OutboxWorker stopping");
        await this.loopPromise;
        log.info("OutboxWorker stopped");
    }

    /**
     * process and send one batch of events.
     * returns the number of rows handled
     */
    async relayOnce(): Promise<number> {
        return await this.source.withTransaction(async tx => {
            const rows = await tx.fetchPending(BATCH_SIZE);
            for (const row of rows) {
                await this.relayRow(tx, row);
            }
            return rows.length;
        });
    }

    /** Restore this row's origin context, trace one attempt, and measure confirmation delay before completion bookkeeping. */
    async relayRow(tx: IOutboxTx, row: OutboxRow): Promise<void> {
        return await withSpan("outbox.relay", {
            attributes: { "outbox.id": row.id, "outbox.retry_count": row.retryCount },
        }, async span => {
            try {
                await this.msgQueue.publishEvent(row.topic, {
                    type: row.type,
                    ...row.payload,
                });
                if (row.createdAt) {
                    const delay = (Date.now() - row.createdAt.epochMilliseconds) / 1000;
                    if (Number.isFinite(delay))
                        outboxConfirmationDelay.record(Math.max(0, delay));
                }
                await tx.markCompleted(row.id);
                outboxAttempts.add(1, { outcome: "success" });
            } catch (e) {
                recordError(e, span);
                const errMsg = e instanceof Error ? e.message : JSON.stringify(e);
                const newRetryCount = row.retryCount + 1;
                const shouldFail = newRetryCount >= MAX_RETRIES;
                outboxAttempts.add(1, { outcome: shouldFail ? "exhausted" : "retry" });
                const nextRetryAt = shouldFail ?
                    null :
                    Temporal.Now.instant().add({
                        milliseconds: calcExpBackoff(BASE_RETRY_DELAY_MS, newRetryCount),
                    });

                if (shouldFail) {
                    log.error(`OutboxWorker giving up on row ${row.id} after ${newRetryCount} retries: ${errMsg}`);
                } else {
                    log.warn(`OutboxWorker failed row ${row.id} (attempt ${newRetryCount}): ${errMsg}`);
                }

                await tx.markFailed(row.id, errMsg, newRetryCount, nextRetryAt);
            }
        }, extractTraceContext(row.metadata));
    }

    private async runLoop(): Promise<void> {
        while (this.running) {
            try {
                const processed = await this.relayOnce();
                outboxLastPoll.record(Date.now() / 1000);
                // idle wait
                if (processed === 0 && this.running)
                    await this.sleep(POLL_INTERVAL_MS);
            } catch (e) {
                outboxBatchFailures.add(1);
                const errMsg = e instanceof Error ? e.message : JSON.stringify(e);
                log.error(`OutboxWorker batch failed: ${errMsg}`);
                await this.sleep(ERROR_BACKOFF_MS);
            }
        }
    }

    /** can be cancelled via cts function */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.sleepCts = null;
                resolve();
            }, ms);

            this.sleepCts = () => {
                clearTimeout(timer);
                this.sleepCts = null;
                resolve();
            };
        });
    }
}

