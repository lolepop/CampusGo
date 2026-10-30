import { parseArgs } from "@std/cli/parse-args";
import { Application, Router } from "@oak/oak";
import { createAuthRouter, createPrivateAuthRouter } from "./routes/auth.ts";
import { connectDatabase, db } from "./prisma/db.ts";
import log from "./log.ts";
import { seedEssential } from "./prisma/seed.ts";
import createUserRouter from "./routes/user.ts";
import createRoleRouter from "./routes/role.ts";
import { generateInviteCodeCli } from "./tasks/cli.ts";
import { buildDefaultProvider } from "./queue/impl/provider.ts";
import { repoFactory } from "./prisma/factory.ts";
import { makeRpcServer } from "./queue/impl/rpc.ts";
import { makeOutboxWorker } from "./queue/impl/outbox.ts";
import type { RabbitMqProvider } from "./queue/provider.ts";
import { createHttpHandler, httpTelemetryMiddleware } from "./middleware/telemetry.ts";
import { OutboxMetricsMonitor } from "./telemetry/outbox.ts";
import { outboxWorkerRunning, rabbitAvailable } from "./telemetry/queue.ts";
import { OutboxRepository } from "./prisma/outbox.ts";
import { UserRepository } from "./prisma/users.ts";
import { AccountMetricsMonitor } from "./telemetry/user.ts";

const flags = parseArgs(Deno.args, {
    boolean: ["gen-invite"],
    default: { "gen-invite": false },
});

// ensure database is ready so that first request is not slow
await connectDatabase();
await seedEssential();

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

        const outboxWorker = makeOutboxWorker(db, repoFactory, rabbitMqProvider);
        try {
            const rpcWorker = makeRpcServer(db, repoFactory, rabbitMqProvider);
        
            outboxWorker.start();
            await rpcWorker.start();
    
            await rabbitMqProvider.waitUntilDown();
            log.warn("queue is down, stopping all queue workers");
        } catch (e) {
            // between queue connection and starting the workers, the network may go down
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
    router.use(createAuthRouter().routes());
    router.use(createUserRouter().routes());
    router.use(createRoleRouter().routes());
    return router;
};

const createPrivateRouter = () => {
    const router = new Router({ prefix: "/private" });
    router.use(createPrivateAuthRouter().routes());
    return router;
};

const main = (port: number) => {
    const app = new Application();
    app.use(httpTelemetryMiddleware);
    
    const publicRouter = createPublicRouter();
    app.use(publicRouter.routes());
    app.use(publicRouter.allowedMethods());
    
    const privateRouter = createPrivateRouter();
    app.use(privateRouter.routes());
    app.use(privateRouter.allowedMethods());
    
    Deno.serve({ port }, createHttpHandler(app));
};

if (flags["gen-invite"]) {
    await generateInviteCodeCli();
} else {
    // Monitoring runs even while the RabbitMQ connection or relay worker is unavailable.
    rabbitAvailable.record(0);
    outboxWorkerRunning.record(0);
    const outboxMonitor = new OutboxMetricsMonitor(() => new OutboxRepository(db).getMetricsSnapshot());
    const accountMonitor = new AccountMetricsMonitor(() => new UserRepository(db).getMetricsSnapshot());
    outboxMonitor.start();
    accountMonitor.start();
    globalThis.addEventListener("unload", () => {
        Promise.allSettled([outboxMonitor.stop(), accountMonitor.stop()]);
    });
    const port = Number(Deno.env.get("PORT") ?? 3000);
    log.info(`starting on port ${port}`);
    startQueueTasks();
    main(port);
}
