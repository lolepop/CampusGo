import type { RouterContext } from "@oak/oak";
import type { JWTPayload } from "jose";
import type { IUserRepository, PublicUserWithRoles } from "../src/prisma/users.ts";
import { IRoleRepository } from "../src/prisma/roles.ts";
import { IPasswordHash } from "../src/util/hash.ts";
import { IJwtService, JwtTokenPair, ValidationResult } from "../src/util/jwt.ts";
import { Role } from "../src/prisma/common.ts";
import { IRepoFactory, Repos } from "../src/prisma/factory.ts";
import { IInviteRepository } from "../src/prisma/invite.ts";
import { IOutboxRepository } from "../src/prisma/outbox.ts";
import { Db, DbTxUnion, Tx } from "../src/prisma/db.ts";
import { IInviteCodeGenerator } from "../src/util/invite.ts";
import { IQueueProvider } from "../src/queue/provider.ts";

// common test constants
export const TEST_EMAIL = "test@example.com";
export const TEST_PASSWORD = "secret123";
export const TEST_HASHED_PASSWORD = `hashed:${TEST_PASSWORD}`;
export const TEST_NICKNAME = "A";
export const TEST_USER_ID = 1;
export const TEST_OTHER_USER_ID = 2;
export const TEST_ADMIN_ID = "1";
export const TEST_REQUESTOR_ID = "2";

export const DEFAULT_TOKEN_PAIR: JwtTokenPair = { accessToken: "access", refreshToken: "refresh" };

export const ADMIN_PAYLOAD: JWTPayload = { sub: TEST_ADMIN_ID, role: [Role.Admin] };
export const USER_PAYLOAD: JWTPayload = { sub: TEST_REQUESTOR_ID, role: [Role.Requestor] };

export function makePublicUser(id: number, overrides: Partial<PublicUserWithRoles> = {}): PublicUserWithRoles {
    return {
        id,
        email: "a@b.com",
        nickname: "A",
        contact: null,
        createdAt: "",
        roles: [Role.Requestor],
        ...overrides,
    };
}

export function makeDb(): Db {
    const tx = {} as Tx;
    return {
        transaction: <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => fn(tx),
    } as unknown as Db;
}


// mock password hashing
export function makeHasher(overrides: Partial<IPasswordHash> = {}): IPasswordHash {
    return {
        hashPassword: overrides.hashPassword ?? (async (pw: string) => `hashed:${pw}`),
        verifyPassword: overrides.verifyPassword ?? (async () => true),
    };
}

// mock jwt service
export function makeJwtService(overrides: Partial<IJwtService> = {}): IJwtService {
    const DEFAULT_TOKEN_PAIR: JwtTokenPair = { accessToken: "access", refreshToken: "refresh" };
    return {
        generateJwtTokenPair: overrides.generateJwtTokenPair ?? (async () => DEFAULT_TOKEN_PAIR),
        validateAccessToken:
            overrides.validateAccessToken ??
            (async () => ({ success: true, payload: {} }) as unknown as ValidationResult),
        validateRefreshToken:
            overrides.validateRefreshToken ??
            (async () => ({ success: true, payload: {} }) as unknown as ValidationResult),
    };
}

// mock invite code generator
export function makeInviteGenerator(overrides: Partial<IInviteCodeGenerator> = {}): IInviteCodeGenerator {
    return {
        generateCode:
            overrides.generateCode ??
            (() => ({ code: "test-code", expiresAt: new Date(Date.now() + 60_000) })),
    };
}

// mock repos
const makeGenericMockRepo = <T>(name: string, overrides: Partial<T> = {}): T => {
    return new Proxy(overrides, {
        get(target, prop) {
            if (prop in target) {
                return Reflect.get(target, prop);
            }
            throw new Error(`mock ${name} repo missing function stub: ${String(prop)}`);
        }
    }) as T;
};

export const makeUserRepo = (overrides: Partial<IUserRepository> = {}): IUserRepository =>
    makeGenericMockRepo("user", overrides);

export const makeRoleRepo = (overrides: Partial<IRoleRepository> = {}): IRoleRepository =>
    makeGenericMockRepo("role", overrides);

export const makeInviteRepo = (overrides: Partial<IInviteRepository> = {}): IInviteRepository =>
    makeGenericMockRepo("invite", overrides);

export const makeOutboxRepo = (overrides: Partial<IOutboxRepository> = {}): IOutboxRepository =>
    makeGenericMockRepo("outbox", overrides);

// not really a repo but whatever
export const makeQueue = (overrides: Partial<IQueueProvider> = {}): IQueueProvider =>
    makeGenericMockRepo("queue", overrides);

export const makeRepoFactory = (overrides: Partial<Repos> = {}): IRepoFactory => ({
    buildRepos: (): Repos => ({
        invite: overrides.invite ?? makeInviteRepo(),
        role: overrides.role ?? makeRoleRepo(),
        user: overrides.user ?? makeUserRepo(),
        outbox: overrides.outbox ?? makeOutboxRepo(),
    }),
});

// oak request/response context mocking
export type CtxOpts = {
    params?: Record<string, string>;
    jwtPayload?: JWTPayload;
    validatedBody?: unknown;
    bodyJson?: unknown | Error;
    headers?: Record<string, string>;
};

/**
 * Mock only the fields that we need as real object is very large
 * Error is thrown if field accessor was for something that was not declared, so that tests will fail fast
 */
export class FakeCtx {
    params: Record<string, string>;
    state: {
        jwtPayload: JWTPayload;
        validatedBody: unknown;
    };
    response: { status: number, body: unknown };
    request: {
        headers: { get: (name: string) => string | null };
        body: unknown | Error;
        hasBody: boolean,
    };

    constructor(opts: CtxOpts = {}) {
        const ctxAccessWrapper = <T extends object>(o: T) => new Proxy(o, {
            get(target, prop) {
                if (prop in target) {
                    return Reflect.get(target, prop);
                }
                throw new Error(`mock oak context missing property: ${String(prop)}`);
            }
        });

        this.params = ctxAccessWrapper(opts.params ?? {});
        this.state = ctxAccessWrapper({
            jwtPayload: opts.jwtPayload ?? {},
            validatedBody: opts.validatedBody,
        });
        this.response = ctxAccessWrapper({ status: 200, body: null as unknown });
        this.request = ctxAccessWrapper({
            headers: {
                get: (name: string) => opts.headers?.[name] ?? null
            },
            body: {
                json: async () => {
                    if (opts.bodyJson instanceof Error)
                        throw opts.bodyJson;
                    return opts.bodyJson;
                },
            },
            hasBody: opts.bodyJson !== undefined,
        });

        return ctxAccessWrapper(this);
    }

    asCtx<R extends string>() {
        return this as unknown as RouterContext<R>;
    }
}
