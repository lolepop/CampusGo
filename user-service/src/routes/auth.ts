import { Router } from "@oak/oak";
import { validateBody } from "../middleware/schema.ts";
import { acceptInviteCodeSchema, AuthController, loginSchema, refreshTokenSchema, registrationSchema } from "../controller/auth.ts";
import { defaultHasher } from "../util/hash.ts";
import { defaultJwtService } from "../util/jwt.ts";
import { defaultInviteCodeGenerator } from "../util/invite.ts";
import { authenticationMiddleware } from "../middleware/auth.ts";
import { repoFactory } from "../prisma/factory.ts";
import { db } from "../prisma/db.ts";

const authController = new AuthController(db, repoFactory, defaultHasher, defaultJwtService, defaultInviteCodeGenerator);
export const createAuthRouter = () => {
    const router = new Router({ prefix: "/auth" });

    router.post("/register", validateBody(registrationSchema), async ctx => {
        await authController.registerUser(ctx);
    });

    router.post("/login", validateBody(loginSchema), async ctx => {
        await authController.login(ctx);
    });

    router.post("/refresh", validateBody(refreshTokenSchema), async ctx => {
        await authController.refreshToken(ctx);
    });

    router.post(
        "/accept-invite",
        authenticationMiddleware(new Set()),
        validateBody(acceptInviteCodeSchema),
        async ctx => {
            await authController.acceptInviteCode(ctx);
        }
    );

    return router;
};

export const createPrivateAuthRouter = () => {
    const router = new Router({ prefix: "/auth" });

    router.post("/invite", async ctx => {
        await authController.generateInviteCode(ctx);
    });

    return router;
};
