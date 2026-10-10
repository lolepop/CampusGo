import log from "../log.ts";
import type { Db } from "../prisma/db.ts";
import type { IRepoFactory } from "../prisma/factory.ts";
import type { IOutboxRepository, PendingEvent } from "../prisma/outbox.ts";
import type { IQueueProvider } from "./provider.ts";

export const BATCH_SIZE = 50;
export const MAX_RETRIES = 5;
export const BASE_RETRY_DELAY_MS = 1000;
export const POLL_INTERVAL_MS = 200;
export const ERROR_BACKOFF_MS = 2000;

/// exponential backoff with jitter
const calcExpBackoff = (baseMs: number, newRetryCount: number) =>
    Math.round(baseMs * 2 ** (newRetryCount - 1) * (0.5 + Math.random()));

export class OutboxWorker {
    private db: Db;
    private repoFactory: IRepoFactory;
    private msgQueue: IQueueProvider;

    private running = false;
    private loopPromise: Promise<void> | null = null;
    private sleepCts: (() => void) | null = null;

    constructor(db: Db, repoFactory: IRepoFactory, msgQueue: IQueueProvider) {
        this.db = db;
        this.repoFactory = repoFactory;
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
        this.loopPromise = this.runLoop().catch(err => {
            log.error(`OutboxWorker loop crashed: ${err?.stack ?? err}`);
        });
        log.info("OutboxWorker started");
    }

    /** safely stop execution and wait for the current batch to finish. */
    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
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
        return await this.db.transaction(async tx => {
            const { outbox } = this.repoFactory.buildRepos(tx);
            const rows = await outbox.getPendingEvents(BATCH_SIZE);
            if (rows.length === 0)
                return 0;

            for (const row of rows) {
                await this.relayRow(outbox, row);
            }
            return rows.length;
        });
    }

    async relayRow(outbox: IOutboxRepository, row: PendingEvent): Promise<void> {
        try {
            await this.msgQueue.publishEvent(row.topic, {
                type: row.type,
                ...row.payload,
            });
            await outbox.updateCompletedEvent(row.id);
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : JSON.stringify(e);
            const newRetryCount = row.retryCount + 1;
            const shouldFail = newRetryCount >= MAX_RETRIES;
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

            // if this fails (db offline), whole batch fails
            await outbox.updateFailedEvent(row.id, errMsg, newRetryCount, nextRetryAt);
        }
    }

    private async runLoop(): Promise<void> {
        while (this.running) {
            try {
                const processed = await this.relayOnce();
                // idle wait
                if (processed === 0 && this.running)
                    await this.sleep(POLL_INTERVAL_MS);
            } catch (e) {
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

