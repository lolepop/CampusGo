import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { spy } from "@std/testing/mock";
import { OutboxWorker, BATCH_SIZE, MAX_RETRIES, BASE_RETRY_DELAY_MS } from "../src/queue/outboxWorker.ts";
import type { PendingEvent } from "../src/prisma/outbox.ts";
import type { Db } from "../src/prisma/db.ts";
import { makeDb, makeOutboxRepo, makeQueue, makeRepoFactory } from "./util.ts";
import type { IOutboxRepository } from "../src/prisma/outbox.ts";

const makeWorkerDb = (): Db => makeDb() as unknown as Db;

const makeEvent = (overrides: Partial<PendingEvent> = {}): PendingEvent => ({
    id: 1,
    type: "userRegistered",
    topic: "user.registered",
    payload: { userId: 100 },
    retryCount: 0,
    ...overrides
});

describe("OutboxWorker.relayOnce", () => {
    it("does nothing when no pending events", async () => {
        const getPendingEvents = spy(async () => []);
        const outbox = makeOutboxRepo({ getPendingEvents });
        const publishEvent = spy(async () => {});
        const worker = new OutboxWorker(makeWorkerDb(), makeRepoFactory({ outbox }), makeQueue({ publishEvent }));

        const processed = await worker.relayOnce();

        assertEquals(processed, 0);
        assertEquals(getPendingEvents.calls.length, 1);
        assertEquals(getPendingEvents.calls[0].args, [BATCH_SIZE]);
        assertEquals(publishEvent.calls.length, 0);
    });

    it("publishes pending events in batch and marks completion", async () => {
        const events = [
            makeEvent({ id: 1, payload: { userId: 42 } }),
            makeEvent({ id: 2, payload: { userId: 43 } }),
        ];
        const getPendingEvents = spy(async () => events);
        const updateCompletedEvent = spy(async () => {});
        const updateFailedEvent = spy(async () => {});
        const outbox = makeOutboxRepo({ getPendingEvents, updateCompletedEvent, updateFailedEvent });
        const publishEvent = spy(async () => {});
        const worker = new OutboxWorker(makeWorkerDb(), makeRepoFactory({ outbox }), makeQueue({ publishEvent }));

        const processed = await worker.relayOnce();

        assertEquals(processed, 2);
        assertEquals(publishEvent.calls.length, 2);
        assertEquals(publishEvent.calls[0].args, ["user.registered", { type: "userRegistered", userId: 42 }]);
        assertEquals(publishEvent.calls[1].args, ["user.registered", { type: "userRegistered", userId: 43 }]);
        assertEquals(updateCompletedEvent.calls.length, 2);
        assertEquals(updateCompletedEvent.calls[0].args, [1]);
        assertEquals(updateCompletedEvent.calls[1].args, [2]);
        assertEquals(updateFailedEvent.calls.length, 0);
    });

    it("propagates errors on db failure", async () => {
        const getPendingEvents = spy(async () => { throw new Error("db offline"); });
        const outbox = makeOutboxRepo({ getPendingEvents });
        const worker = new OutboxWorker(makeWorkerDb(), makeRepoFactory({ outbox }), makeQueue());

        await assertRejects(() => worker.relayOnce(), Error, "db offline");
    });

    it("aborts batch if failure cannot be recorded", async () => {
        const events = [makeEvent({ id: 1 }), makeEvent({ id: 2 })];
        const getPendingEvents = spy(async () => events);
        const publishEvent = spy(async () => { throw new Error("queue down"); });
        const updateFailedEvent = spy(async () => { throw new Error("db down"); });
        const outbox = makeOutboxRepo({ getPendingEvents, updateFailedEvent });
        const worker = new OutboxWorker(makeWorkerDb(), makeRepoFactory({ outbox }), makeQueue({ publishEvent }));

        await assertRejects(() => worker.relayOnce(), Error, "db down");

        assertEquals(updateFailedEvent.calls.length, 1);
        const [id] = (<unknown[]>updateFailedEvent.calls[0].args) as Parameters<IOutboxRepository["updateFailedEvent"]>;
        assertEquals(id, 1);
    });
});

describe("OutboxWorker.relayRow", () => {
    it("marks the event failed with backoff on publish failure", async () => {
        const publishEvent = spy(async () => { throw new Error("queue down"); });
        const updateCompletedEvent = spy(async () => {});
        const updateFailedEvent = spy(async () => {});
        const outbox = makeOutboxRepo({ updateCompletedEvent, updateFailedEvent });
        const worker = new OutboxWorker(makeWorkerDb(), makeRepoFactory({ outbox }), makeQueue({ publishEvent }));

        const before = Temporal.Now.instant().epochMilliseconds;
        await worker.relayRow(outbox, makeEvent({ id: 10, retryCount: 0 }));

        assertEquals(updateCompletedEvent.calls.length, 0);
        assertEquals(updateFailedEvent.calls.length, 1);

        const [id, errMsg, retryCount, nextRetryAt] = (<unknown[]>updateFailedEvent.calls[0].args) as Parameters<IOutboxRepository["updateFailedEvent"]>;
        assertEquals(id, 10);
        assertEquals(errMsg, "queue down");
        assertEquals(retryCount, 1);
        assertInstanceOf(nextRetryAt, Temporal.Instant);

        const delayMs = (nextRetryAt as Temporal.Instant).epochMilliseconds - before;
        assert(delayMs >= 0, "backoff not set");
    });

    it("gives up once max retries exhausted is reached", async () => {
        const publishEvent = spy(async () => { throw new Error("queue down"); });
        const updateFailedEvent = spy(async () => {});
        const outbox = makeOutboxRepo({ updateFailedEvent });
        const worker = new OutboxWorker(makeWorkerDb(), makeRepoFactory({ outbox }), makeQueue({ publishEvent }));

        await worker.relayRow(outbox, makeEvent({ id: 1, retryCount: MAX_RETRIES - 1 }));

        assertEquals(updateFailedEvent.calls.length, 1);
        const [id, errMsg, retryCount, nextRetryAt] = (<unknown[]>updateFailedEvent.calls[0].args) as Parameters<IOutboxRepository["updateFailedEvent"]>;
        assertEquals(retryCount, MAX_RETRIES);
        assertEquals(nextRetryAt, null);
    });

    it("failure to mark completion is recorded as failure in db", async () => {
        const publishEvent = spy(async () => {});
        const updateCompletedEvent = spy(async () => { throw new Error("db write failed"); });
        const updateFailedEvent = spy(async () => {});
        const outbox = makeOutboxRepo({ updateCompletedEvent, updateFailedEvent });
        const worker = new OutboxWorker(makeWorkerDb(), makeRepoFactory({ outbox }), makeQueue({ publishEvent }));

        await worker.relayRow(outbox, makeEvent({ id: 1 }));

        assertEquals(updateCompletedEvent.calls.length, 1);
        assertEquals(updateFailedEvent.calls.length, 1);
        const [id, errMsg] = (<unknown[]>updateFailedEvent.calls[0].args) as Parameters<IOutboxRepository["updateFailedEvent"]>;
        assertEquals(errMsg, "db write failed");
    });
});
