import { parseArgs } from "@std/cli/parse-args";
import { Application, Router } from "@oak/oak";
import { createAuthRouter, createPrivateAuthRouter } from "./routes/auth.ts";
import { connectDatabase, db } from "./prisma/db.ts";
import log from "./log.ts";
import { seedEssential } from "./prisma/seed.ts";
import createUserRouter from "./routes/user.ts";
import createRoleRouter from "./routes/role.ts";
import { generateInviteCodeCli } from "./tasks/cli.ts";
import { buildDefaultProvider } from "./queue/provider.ts";
import { repoFactory } from "./prisma/factory.ts";
import { OutboxWorker } from "./queue/outboxWorker.ts";
import { makeRpcServer } from "./queue/rpc/server.ts";

const flags = parseArgs(Deno.args, {
    boolean: ["gen-invite"],
    default: { "gen-invite": false },
});

// ensure database is ready so that first request is not slow
await connectDatabase();
await seedEssential();

const rabbitMqProvider = await buildDefaultProvider()
const outboxWorker = new OutboxWorker(db, repoFactory, rabbitMqProvider);
const rpcWorker = makeRpcServer(db, repoFactory, rabbitMqProvider);

outboxWorker.start();
rpcWorker.start();

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
    
    const publicRouter = createPublicRouter();
    app.use(publicRouter.routes());
    app.use(publicRouter.allowedMethods());
    
    const privateRouter = createPrivateRouter();
    app.use(privateRouter.routes());
    app.use(privateRouter.allowedMethods());
    
    app.listen({ port });
};

if (flags["gen-invite"]) {
    await generateInviteCodeCli();
} else {
    const port = Number(Deno.env.get("PORT") ?? 3000);
    log.info(`starting on port ${port}`);
    main(port);
}
