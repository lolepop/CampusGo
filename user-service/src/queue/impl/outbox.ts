import type { Db } from "../../prisma/db.ts";
import type { IRepoFactory } from "../../prisma/factory.ts";
import type { IOutboxRepository, PendingEvent } from "../../prisma/outbox.ts";
import { OutboxWorker, type IOutboxSource, type IOutboxTx, type OutboxRow } from "../outboxWorker.ts";
import type { IQueueProvider } from "../provider.ts";
import { withTracedTransaction } from "../../prisma/transaction.ts";

// wrappers around db handling
const makeOutboxTx = (outbox: IOutboxRepository): IOutboxTx => ({
    fetchPending: async limit => {
        const pendingEvents = await outbox.getPendingEvents(limit);
        return pendingEvents.map<OutboxRow>(r => ({ ...r })); // type check
    },
    markCompleted: id =>
        outbox.updateCompletedEvent(id as Parameters<IOutboxRepository["updateCompletedEvent"]>[0]),
    markFailed: (id, errMsg, retryCount, nextRetryAt) =>
        outbox.updateFailedEvent(id as Parameters<IOutboxRepository["updateFailedEvent"]>[0], errMsg, retryCount, nextRetryAt)
});

const makeOutboxSource = (db: Db, repoFactory: IRepoFactory): IOutboxSource => ({
    withTransaction: <R>(fn: (tx: IOutboxTx) => Promise<R>) =>
        withTracedTransaction(db, tx => {
            const { outbox } = repoFactory.buildRepos(tx);
            return fn(makeOutboxTx(outbox));
        }),
});

export const makeOutboxWorker = (db: Db, repoFactory: IRepoFactory, msgQueue: IQueueProvider): OutboxWorker => {
    return new OutboxWorker(makeOutboxSource(db, repoFactory), msgQueue);
}
