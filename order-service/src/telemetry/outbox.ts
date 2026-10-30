// AI assistance (26/9/2026): codex
// generated worker followed my design requirements for extracting the metrics i specified. it also added heartbeats and query duration metrics, which was a nice bonus.

import { meter } from "./instruments.ts";
import { SnapshotMonitor } from "./snapshot.ts";

/** One SQL statement reads a consistent durable backlog, independently of the publisher. */
export interface OutboxSnapshot {
    ready: number;
    delayed: number;
    oldestPendingAge: number;
}

/** Cached outbox observations; scheduling, freshness, diagnostics, and disposal use the shared monitor. */
export class OutboxMetricsMonitor extends SnapshotMonitor<OutboxSnapshot> {
    constructor(
        read: () => Promise<OutboxSnapshot>,
        now = Date.now,
        intervalMs = 30000,
        staleAfterMs = 90000,
    ) {
        super("campusgo.outbox", read, snapshot =>
            [snapshot.ready, snapshot.delayed, snapshot.oldestPendingAge]
                .every(value => Number.isFinite(value) && value >= 0), { now, intervalMs, staleAfterMs });
        this.observe(meter.createObservableGauge("campusgo.outbox.backlog"), result => {
            const snapshot = this.getFreshSnapshot();
            if (snapshot) {
                for (const state of ["ready", "delayed"] as const)
                    result.observe(snapshot[state], { state });
            }
        });
        this.observe(meter.createObservableGauge("campusgo.outbox.oldest_pending.age", { unit: "s" }), result => {
            const snapshot = this.getFreshSnapshot();
            if (snapshot) {
                const pending = snapshot.ready + snapshot.delayed;
                result.observe(pending ? snapshot.oldestPendingAge + Math.max(0, this.now() - this.lastSuccessMs) / 1000 : 0);
            }
        });
    }
}
