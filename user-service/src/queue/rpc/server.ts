import log from "../../log.ts";
import type { DbTxUnion } from "../../prisma/db.ts";
import type { IRepoFactory } from "../../prisma/factory.ts";
import type { IQueueProvider } from "../provider.ts";
import { RpcBadRequest, RpcRouter } from "./router.ts";

// exmaple of rpc response messages:
// const q = await rabbitMqProvider.createReplyQueue();
// const user = await q.call("user.query", { userId: "asdasd" });
// {"ok":false,"error":"INVALID_USER_ID"}

// const user = await q.call("user.query", { userId: 99999 });
// {"ok":true,"result":{"userExists":false}}

// const user = await q.call("user.query", { userId: 1 });
// {"ok":true,"result":{"userExists":true}}

class RpcServer {
    db: DbTxUnion
    repoFactory: IRepoFactory

    constructor(db: DbTxUnion, repoFactory: IRepoFactory) {
        this.db = db;
        this.repoFactory = repoFactory;
    }

    async checkUserExists(payload: any) {
        const userId = payload?.userId;
        if (typeof userId !== "number")
            throw new RpcBadRequest("INVALID_USER_ID");

        const { user } = this.repoFactory.buildRepos(this.db);
        try {
            const u = await user.getUserByIdPublic(userId);
            return { userExists: !!u };
        } catch (e) {
            log.warn(`RpcServer [checkUserExists]: failed with error ${e instanceof Error ? e.stack : e}`);
            throw new RpcBadRequest("DB_ERROR");
        }
    }
}

export const makeRpcServer = (db: DbTxUnion, repoFactory: IRepoFactory, queue: IQueueProvider) => {
    const router = new RpcRouter("user.rpc", queue);
    const server = new RpcServer(db, repoFactory);

    router.register("user.query", payload => server.checkUserExists(payload));
    return router;
}
