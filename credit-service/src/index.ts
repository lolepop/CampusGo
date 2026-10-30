import { OutboxRepository } from "./prisma/outbox.ts";
import { rabbitAvailable, outboxWorkerRunning } from "./telemetry/queue.ts";
import { OutboxMetricsMonitor } from "./telemetry/outbox.ts";
import { createHttpHandler, httpTelemetryMiddleware } from "./middleware/telemetry.ts";
import { startHeartbeat } from "./telemetry/heartbeat.ts";
import log from "./log.ts";
import { Application, Router } from "@oak/oak";
import { connectDatabase, db } from "./prisma/db.ts";
import { createPublicCreditRouter } from "./routes/credits.ts";
import { createPrivateCreditRouter } from "./routes/credits.ts";
import { buildDefaultProvider } from "./queue/impl/provider.ts";
import { makeOutboxWorker } from "./queue/impl/outbox.ts";
import type { RabbitMqProvider } from "./queue/provider.ts";


// Ensure the database is ready before accepting requests.
await connectDatabase();

const stopHeartbeat = startHeartbeat();
globalThis.addEventListener("unload", stopHeartbeat);
rabbitAvailable.record(0);
outboxWorkerRunning.record(0);
const outboxMonitor = new OutboxMetricsMonitor(() => new OutboxRepository(db).getMetricsSnapshot());
outboxMonitor.start();
globalThis.addEventListener("unload", () => { void outboxMonitor.stop(); });


const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const startQueueTasks = async () => {
    const ERROR_BACKOFF_MS = 5000;

    log.debug("initiating queue connection");
    let rabbitMqProvider: RabbitMqProvider | null = null;
    while (!rabbitMqProvider) {
        try {
            rabbitMqProvider = await buildDefaultProvider();
        } catch (e) {
            log.warn(`first connection to queue failed: ${e}`);
            await sleep(ERROR_BACKOFF_MS);
        }
    }
    while (rabbitMqProvider.getState() !== "closed") {
        try {
            log.debug("waiting for queue to go up");
            await rabbitMqProvider.waitUntilUp();
            log.info("queue connection established");
        } catch {
            break;
        }

        const outboxWorker = makeOutboxWorker(db, rabbitMqProvider);
        try {
            outboxWorker.start();

            await rabbitMqProvider.waitUntilDown();
            log.warn("queue is down, stopping all queue workers");
        } catch (e) {
            // Between queue connection and starting the workers, the network may go down.
            log.error(`queue task cycle failed: ${e}`);
            await sleep(ERROR_BACKOFF_MS);
        } finally {
            await outboxWorker.stop();
        }
    }

    await rabbitMqProvider.close();
};

const createPublicRouter = () => {
    const router = new Router({ prefix: "/public" });
    router.get("/health", ctx => {
        ctx.response.body = "ok";
    });
    router.use(createPublicCreditRouter().routes());
    return router;
};

const createPrivateRouter = () => {
    const router = new Router({ prefix: "/private" });
    router.get("/health", ctx => {
        ctx.response.body = "ok";
    });
    router.use(createPrivateCreditRouter().routes());
    return router;
};

const main = async (port: number) => {
    const app = new Application();
    app.use(httpTelemetryMiddleware);

    const privateRouter = createPrivateRouter();
    const publicRouter = createPublicRouter();
    app.use(publicRouter.routes());
    app.use(publicRouter.allowedMethods());
    app.use(privateRouter.routes());
    app.use(privateRouter.allowedMethods());

    await Deno.serve({ port }, createHttpHandler(app)).finished;
};

const port = Number(process.env.PORT ?? 3000);
log.info(`starting on port ${port}`);

startQueueTasks();
await main(port);
