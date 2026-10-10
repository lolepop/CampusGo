import { AuthController } from "../controller/auth.ts";
import { defaultHasher } from "../util/hash.ts";
import { defaultJwtService } from "../util/jwt.ts";
import { defaultInviteCodeGenerator } from "../util/invite.ts";
import { db } from "../prisma/db.ts";
import { repoFactory } from "../prisma/factory.ts";

export const generateInviteCodeCli = async () => {
    const authController = new AuthController(db, repoFactory, defaultHasher, defaultJwtService, defaultInviteCodeGenerator);
    const code = await authController.generateInviteCodeNoCtx();
    console.log(`successfully generated code: ${code}`);
};