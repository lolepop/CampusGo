import { Router, type RouterContext } from "@oak/oak";
import { authenticationMiddleware } from "../middleware/auth.ts";
import { RoleController } from "../controller/roles.ts";
import { Role } from "../prisma/common.ts";
import { repoFactory } from "../prisma/factory.ts";
import { db } from "../prisma/db.ts";

const { role } = repoFactory.buildRepos(db);
const roleController = new RoleController(role);
const createRoleRouter = () => {
    const router = new Router({ prefix: "/role" });

    router.get("/", authenticationMiddleware(new Set([Role.Admin])), async ctx => {
        await roleController.listRoles(ctx as RouterContext<"/">);
    });
    return router;
};

export default createRoleRouter;
