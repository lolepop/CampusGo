import log from "../log.ts";
import type { Context } from "@oak/oak";
import { defaultJwtService, type IJwtService } from "../util/jwt.ts";
import { fromRawRole, Role } from "../common.ts";

export interface AuthenticatedUser {
    id: number;
    roles: Role[];
}

const reject = (ctx: Context, status: 401 | 403, error: string, userId?: number) => {
    ctx.response.status = status;
    ctx.response.body = { error };
    log.warn(`${status} ${ctx.request.method} ${ctx.request.url.pathname} user=${userId ?? "unknown"}: ${error}`);
};

export const authenticationMiddlewareWithJwtProvider = (jwtService: IJwtService, rolesRequired: ReadonlySet<Role>) =>
    async (ctx: Context, next: () => Promise<unknown>) => {
        const authHeader = ctx.request.headers.get("authorization");
        if (!authHeader?.startsWith("Bearer ")) {
            reject(ctx, 401, "missing bearer token");
            return;
        }

        const result = await jwtService.validateAccessToken(authHeader.slice("Bearer ".length).trim());
        if (!result.success) {
            reject(ctx, 401, result.error === "EXPIRED" ? "access token expired" : "access token is of invalid format");
            return;
        }

        const subject = result.payload.sub;
        const userId = Number(subject);
        if (typeof subject !== "string" || !/^\d+$/.test(subject) || !Number.isSafeInteger(userId) || userId <= 0) {
            reject(ctx, 401, "access token is of invalid format");
            return;
        }

        const rawRoles: unknown[] = Array.isArray(result.payload.role) ? result.payload.role : [];
        const roles = rawRoles
            .map(role => typeof role === "string" ? fromRawRole(role) : null)
            .filter((role): role is Role => role !== null);

        const user: AuthenticatedUser = { id: userId, roles };
        ctx.state.user = user;

        if ([...rolesRequired].some(role => !roles.includes(role))) {
            reject(ctx, 403, "insufficient permissions to perform action", userId);
            return;
        }
        await next();
    };

// An empty set allows any authenticated user; specified roles are all required.
export const authenticationMiddleware = (rolesRequired: ReadonlySet<Role>) =>
    authenticationMiddlewareWithJwtProvider(defaultJwtService, rolesRequired);

