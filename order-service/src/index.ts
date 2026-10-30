import { getOutboxSnapshot } from "./prisma/outbox.ts";
import { OutboxMetricsMonitor } from "./telemetry/outbox.ts";
import { createHttpHandler, httpTelemetryMiddleware } from "./middleware/telemetry.ts";
import { startHeartbeat } from "./telemetry/heartbeat.ts";
import { Application, Router } from "@oak/oak";
import orderRouter from "./routes/order.ts";
import { connectDatabase } from "./prisma/db.ts";
import { expireDueErrands } from "./controller/order.ts";
import config from "./config.ts";
import log from "./log.ts";
import { connectRabbitMQ } from "./rabbitmq/client.ts";
import { startOutboxWorker } from "./rabbitmq/outbox.ts";

const port = Number(Deno.env.get("PORT") ?? 3000);

// ensure database is ready so that first request is not slow
await connectDatabase();

const stopHeartbeat = startHeartbeat();
globalThis.addEventListener("unload", stopHeartbeat);
const outboxMonitor = new OutboxMetricsMonitor(getOutboxSnapshot);
outboxMonitor.start();
globalThis.addEventListener("unload", () => { void outboxMonitor.stop(); });


const publicRouter = new Router({ prefix: "/public" });

publicRouter.get("/health", ctx => {
    ctx.response.body = "ok";
});

publicRouter.use(orderRouter.routes());

const privateRouter = new Router({ prefix: "/private" });
// Add private endpoints (service-to-service) here later.

const app = new Application();
app.use(httpTelemetryMiddleware);

app.use(publicRouter.routes());
app.use(publicRouter.allowedMethods());

app.use(privateRouter.routes());
app.use(privateRouter.allowedMethods());

// RabbitMQ: connect with retry in the background (no await: the HTTP server must start even if
// the broker is not ready yet), and relay the outbox once the connection is up
void connectRabbitMQ();
startOutboxWorker();

// expire due errands (their refund events are queued by expireDueOrders) even if nobody opens them
setInterval(() => {
    expireDueErrands().catch(e => log.error(`expiry job failed: ${e}`));
}, config.order.expiry.checkIntervalMs);

log.info(`starting on port ${port}`);
await Deno.serve({ port }, createHttpHandler(app)).finished;
