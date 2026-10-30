import { context, ROOT_CONTEXT, type ObservableGauge, type ObservableResult } from "@opentelemetry/api";
import log from "../log.ts";
import { meter, queueDurationOptions } from "./instruments.ts";

export interface SnapshotMonitorOptions {
    now?: () => number;
    intervalMs?: number;
    staleAfterMs?: number;
}

/**
 * shared lifecycle for expensive metrics. Reads run outside request context, never overlap,
 * and are independent of export callbacks and RabbitMQ. Failed reads retain the last snapshot
 * until stale; they never fabricate empty state. Call stop() to remove callbacks and timers.
 */
export class SnapshotMonitor<T> {
    private snapshot?: T;
    private lastSuccess = 0;
    private collecting?: Promise<void>;
    private timer?: ReturnType<typeof setTimeout>;
    private running = false;
    private disposed = false;
    private readonly cleanup: (() => void)[] = [];
    protected readonly now: () => number;
    private readonly intervalMs: number;
    private readonly staleAfterMs: number;
    private readonly failures;
    private readonly duration;

    constructor(
        private readonly name: string,
        private readonly read: () => Promise<T>,
        private readonly validate: (value: T) => boolean,
        options: SnapshotMonitorOptions = {},
    ) {
        this.now = options.now ?? Date.now;
        this.intervalMs = options.intervalMs ?? 30000;
        this.staleAfterMs = options.staleAfterMs ?? 90000;
        this.failures = meter.createCounter(`${name}.snapshot.failures`, { unit: "1" });
        this.duration = meter.createHistogram(`${name}.snapshot.duration`, queueDurationOptions);
        this.observe(meter.createObservableGauge(`${name}.snapshot.available`), result => {
            result.observe(this.getFreshSnapshot() === undefined ? 0 : 1);
        });
        this.observe(meter.createObservableGauge(`${name}.snapshot.last_success`, { unit: "s" }), result => {
            result.observe(this.lastSuccess / 1000);
        });
    }

    /** Register a cached-state observer whose removal belongs to this monitor's lifecycle. */
    protected observe(instrument: ObservableGauge, callback: (result: ObservableResult) => void): void {
        instrument.addCallback(callback);
        this.cleanup.push(() => instrument.removeCallback(callback));
    }

    /** Missing/stale snapshots are unavailable, rather than an observed zero count. */
    protected getFreshSnapshot(): T | undefined {
        return !this.disposed && this.snapshot !== undefined && this.now() - this.lastSuccess <= this.staleAfterMs ?
            this.snapshot : undefined;
    }

    protected get lastSuccessMs(): number { return this.lastSuccess; }

    /** Refresh once; concurrent calls share the same read. Errors are diagnosed and contained. */
    refresh(): Promise<void> {
        if (this.disposed)
            return Promise.resolve();
        return this.collecting ??= context.with(ROOT_CONTEXT, async () => {
            const start = performance.now();
            let outcome = "success";
            try {
                const snapshot = await this.read();
                if (!this.validate(snapshot))
                    throw new Error(`Invalid ${this.name} metrics snapshot`);
                this.snapshot = snapshot;
                this.lastSuccess = this.now();
                // log.debug(`${this.name} metrics snapshot taken`);
            } catch (error) {
                outcome = "error";
                this.failures.add(1);
                log.warn(`${this.name} metrics snapshot failed: ${error}`);
            } finally {
                this.duration.record((performance.now() - start) / 1000, { outcome });
            }
        }).finally(() => { this.collecting = undefined; });
    }

    /** Poll immediately, then wait after each settled read. A disposed monitor cannot restart. */
    start(): void {
        if (this.running || this.disposed)
            return;
        this.running = true;
        const poll = async () => {
            await this.refresh();
            if (this.running)
                this.timer = setTimeout(() => { void poll(); }, this.intervalMs);
        };
        void poll();
    }

    /** Permanently dispose observers/timers and await the current read; DB cancellation is driver-owned. */
    async stop(): Promise<void> {
        this.running = false;
        this.disposed = true;
        clearTimeout(this.timer);
        for (const dispose of this.cleanup.splice(0))
            dispose();
        await this.collecting;
    }
}
