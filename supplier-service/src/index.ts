// import { Application, Router } from "@oak/oak";
// import { connectDatabase } from "./prisma/db.ts";
// import log from "./log.ts";
// import createSupplierRouter, { createPrivateSupplierRouter } from "./routes/supplier.ts";
// import router from "./routes/supplier.ts";

// const port = Number(Deno.env.get("PORT") ?? 3000);
// log.info(`starting on port ${port}`);

// // ensure database is ready so that first request is not slow
// await connectDatabase();

// const createPublicRouter = () => {
//     const router = new Router({ prefix: "/public" });
//     router.get("/health", ctx => {
//         ctx.response.body = "ok";
//     });
//     router.use(createSupplierRouter().routes());
//     return router;
// };

// const createPrivateRouter = () => {
//     const router = new Router({ prefix: "/private" });
//     router.use(createPrivateSupplierRouter().routes());
//     return router;
// };

// const app = new Application();

// const publicRouter = createPublicRouter();
// app.use(publicRouter.routes());
// app.use(publicRouter.allowedMethods());

// const privateRouter = createPrivateRouter();
// app.use(privateRouter.routes());
// app.use(privateRouter.allowedMethods());

// app.listen({ port });

import { createHttpHandler, httpTelemetryMiddleware } from "./middleware/telemetry.ts";
import { startHeartbeat } from "./telemetry/heartbeat.ts";

import { Application, Router } from "@oak/oak";
import supplierRouter from "./routes/supplier.ts";
import locationRouter from "./routes/location.ts";
import { connectDatabase } from "./prisma/db.ts";

await connectDatabase();
const stopHeartbeat = startHeartbeat();
globalThis.addEventListener("unload", stopHeartbeat);

const publicRouter = new Router({ prefix: "/public" });

publicRouter.get("/health", ctx => {
    ctx.response.body = "ok";
});

publicRouter.use(supplierRouter.routes());
publicRouter.use(locationRouter.routes());

const privateRouter = new Router({ prefix: "/private" });
// Add private endpoints here later.

const app = new Application();
app.use(httpTelemetryMiddleware);

app.use(publicRouter.routes());
app.use(publicRouter.allowedMethods());

app.use(privateRouter.routes());
app.use(privateRouter.allowedMethods());

await Deno.serve({ port: Number(Deno.env.get("PORT") ?? 3000) }, createHttpHandler(app)).finished;

