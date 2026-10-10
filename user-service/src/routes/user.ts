import { Router, type RouterContext } from "@oak/oak";
import { UserController, userUpdateBasicSchema, userUpdatePasswordSchema, userUpdateRoleSchema } from "../controller/user.ts"
import { authenticationMiddleware } from "../middleware/auth.ts";
import { validateBody } from "../middleware/schema.ts";
import { Role } from "../prisma/common.ts";
import { defaultHasher } from "../util/hash.ts";
import { repoFactory } from "../prisma/factory.ts";
import { db } from "../prisma/db.ts";

const { user, role } = repoFactory.buildRepos(db);
const userController = new UserController(user, role, defaultHasher);
const createUserRouter = () => {
    const router = new Router({ prefix: "/user" });

    router.get("/", authenticationMiddleware(new Set([Role.Admin])), async ctx => {
        // HACK: ctx typing seems to break only in root path
        await userController.listUsers(ctx as RouterContext<"/">);
    });

    router.get("/:id", authenticationMiddleware(new Set()), async ctx => {
        await userController.getUser(ctx);
    });

    router.put(
        "/:id",
        authenticationMiddleware(new Set()),
        validateBody(userUpdateBasicSchema),
        async ctx => {
            await userController.updateUserBasic(ctx);
        }
    );

    router.patch(
        "/:id/role",
        authenticationMiddleware(new Set([Role.Admin])),
        validateBody(userUpdateRoleSchema),
        async ctx => {
            await userController.updateUserRole(ctx);
        }
    );

    router.post(
        "/:id/change-password",
        authenticationMiddleware(new Set()),
        validateBody(userUpdatePasswordSchema),
        async ctx => {
            await userController.updateUserPassword(ctx);
        }
    );

    return router;
};

export default createUserRouter;
