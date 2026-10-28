import { db, type DbTxUnion, isTransaction } from "./db.ts";
import type { AccountSnapshot } from "../telemetry/user.ts";
import log from "../log.ts";
import Constants from "./constants.ts";
import { DbError, ErrorType, Role } from "./common.ts";
import { fromRawRoleThrows } from "./roles.ts";

// export { db };

export type RawUserRecord = typeof db.orm.public.User._row;
export type UserWithRoles = RawUserRecord & { roles: Role[] };
export type PublicUserWithRoles = {
    id: number;
    createdAt: string;
    email: string;
    nickname: string;
    contact: string | null;
    isSuspended: boolean;
    roles: Role[];
};

export type ListUsersOptions = {
    name?: string;
    role: Role[];
    limit: number;
    cursor?: number;
};

export type ListUsersResult = {
    data: PublicUserWithRoles[];
    pagination: {
        limit: number;
        hasMore: boolean;
        nextCursor: number | null;
    };
};

export interface IUserRepository {
    registerUser(email: string, hashedPassword: string, nickname: string): Promise<RawUserRecord>;
    getUserByEmail(email: string): Promise<UserWithRoles | null>;
    getUserByIdPublic(id: number): Promise<PublicUserWithRoles | null>;
    getUserByIdWithPassword(id: number): Promise<UserWithRoles | null>;
    updateUserBasic(id: number, nickname: string, contact: string | null): Promise<RawUserRecord | null>;
    updateUserPassword(id: number, hashedPassword: string): Promise<RawUserRecord | null>;
    updateUserSuspension(id: number, isSuspended: boolean): Promise<RawUserRecord | null>;
    listUsers(options: ListUsersOptions): Promise<ListUsersResult>;
}

const viewProfileValidFields: Parameters<typeof db.orm.public.User.select> = ["id", "email", "createdAt", "nickname", "contact", "isSuspended"];

export class UserRepository implements IUserRepository {
    db: DbTxUnion;

    constructor(db: DbTxUnion) {
        this.db = db;
    }

    /** aggregate for monitoring: total counts of suspended, non-suspended (to infer total users) */
    async getMetricsSnapshot(): Promise<AccountSnapshot> {
        const query = db.raw.sql`
            SELECT
                (COUNT(*) FILTER (WHERE NOT "isSuspended"))::integer AS "notSuspended",
                (COUNT(*) FILTER (WHERE "isSuspended"))::integer AS suspended
            FROM "user"
        `.returnsRow({
            notSuspended: db.sql.public.user.columns.id,
            suspended: db.sql.public.user.columns.id,
        }).build();
        const rows = isTransaction(this.db) ? await this.db.query(query) : await this.db.runtime().query(query);
        return { notSuspended: rows[0].notSuspended, suspended: rows[0].suspended };
    }

    async registerUser(email: string, hashedPassword: string, nickname: string): Promise<RawUserRecord> {
        const emailLowercased = email.toLowerCase();
        try {
            const user = await this.db.orm.public.User.create({ email: emailLowercased, hashedPassword, nickname });
            log.debug(`email was registered: ${email}`);
            return user;
        } catch (e) {
            const ex = e as { sqlState?: string };
            if (ex.sqlState == Constants.uniqueConstraintViolated) {
                log.debug(`duplicate register attempt blocked on email: ${email}`);
                throw new DbError({
                    status: ErrorType.ConstraintViolation,
                    isUserFault: true,
                    message: "email is already registered"
                });
            }
            log.error(`unknown error registering (${email}): ${JSON.stringify(e)}`);
            throw new DbError({
                status: ErrorType.Unknown,
                isUserFault: false,
                message: `unknown error: ${e}`
            })
        }
    }

    async getUserByEmail(email: string): Promise<UserWithRoles | null> {
        const emailLowercased = email.toLowerCase();
        try {
            const user = await this.db.orm.public.User.where({ email: emailLowercased })
                .include("roles")
                .first();
            if (!user)
                return null
            const roles = user.roles.map(fromRawRoleThrows);
            return { ...user, roles };
        } catch (e) {
            log.error(`unknown error looking up user by email (${email}): ${JSON.stringify(e)}`);
            throw new DbError({
                status: ErrorType.Unknown,
                isUserFault: false,
                message: `unknown error: ${e}`
            })
        }
    }

    /**
     * Should not return info such as password hashes
     */
    async getUserByIdPublic(id: number): Promise<PublicUserWithRoles | null> {
        try {
            const user = await this.db.orm.public.User.select(...viewProfileValidFields)
                .where({ id })
                .include("roles")
                .first();
            if (!user)
                return null
            const roles = user.roles.map(fromRawRoleThrows);
            return { ...user, roles };
        } catch (e) {
            log.error(`unknown error looking up user by id (${id}): ${JSON.stringify(e)}`);
            throw new DbError({
                status: ErrorType.Unknown,
                isUserFault: false,
                message: `unknown error: ${e}`
            })
        }
    }

    /**
     * Updates nickname and contact field
     */
    async updateUserBasic(id: number, nickname: string, contact: string | null): Promise<RawUserRecord | null> {
        try {
            const updatedUser = await this.db.orm.public.User.where({ id })
                .update({ nickname, contact });
            return updatedUser;
        } catch (e) {
            log.error(`unknown error updating user by id (${id}): ${JSON.stringify(e)}`);
            throw new DbError({
                status: ErrorType.Unknown,
                isUserFault: false,
                message: `unknown error: ${e}`
            })
        }
    }

    /**
     * Returns full user record including hashedPassword.
     * IMPORTANT: Do not expose this to info to any external client/user
     */
    async getUserByIdWithPassword(id: number): Promise<UserWithRoles | null> {
        try {
            const user = await this.db.orm.public.User.where({ id })
                .include("roles")
                .first();

            if (!user)
                return null;

            const roles = user.roles.map(fromRawRoleThrows);
            return { ...user, roles };
        } catch (e) {
            log.error(`unknown error looking up user by id with password (${id}): ${JSON.stringify(e)}`);
            throw new DbError({
                status: ErrorType.Unknown,
                isUserFault: false,
                message: `unknown error: ${e}`
            });
        }
    }

    /**
     * Updates only the password hash.
     */
    async updateUserPassword(id: number, hashedPassword: string): Promise<RawUserRecord | null> {
        try {
            const updatedUser = await this.db.orm.public.User.where({ id })
                .update({ hashedPassword });
            return updatedUser;
        } catch (e) {
            log.error(`unknown error updating password for user by id (${id}): ${JSON.stringify(e)}`);
            throw new DbError({
                status: ErrorType.Unknown,
                isUserFault: false,
                message: `unknown error: ${e}`
            });
        }
    }

    /**
     * Updates suspension status without changing roles.
     */
    async updateUserSuspension(id: number, isSuspended: boolean): Promise<RawUserRecord | null> {
        try {
            const updatedUser = await this.db.orm.public.User.where({ id })
                .update({ isSuspended });
            return updatedUser;
        } catch (e) {
            log.error(`unknown error updating suspension for user by id (${id}): ${JSON.stringify(e)}`);
            throw new DbError({
                status: ErrorType.Unknown,
                isUserFault: false,
                message: `unknown error: ${e}`
            });
        }
    }

    /**
     * Lists a filtered page of users with public fields only.
     */
    async listUsers(options: ListUsersOptions): Promise<ListUsersResult> {
        try {
            let query = this.db.orm.public.User
                .select(...viewProfileValidFields)
                .include("roles");

            if (options.name !== undefined) {
                const escapedName = options.name.replace(/[\\%_]/g, "\\$&");
                query = query.where(user => user.nickname.ilike(`%${escapedName}%`));
            }
            for (const role of options.role) {
                query = query.where(user => user.roles.some(assigned => assigned.name.eq(role)));
            }
            if (options.cursor !== undefined) {
                const cursor = options.cursor;
                query = query.where(user => user.id.gt(cursor));
            }

            const users = await query
                .orderBy(user => user.id.asc())
                .limit(options.limit + 1)
                .all();

            const hasMore = users.length > options.limit;
            const data = users.slice(0, options.limit).map(user => ({
                ...user,
                roles: user.roles.map(fromRawRoleThrows),
            }));
            return {
                data,
                pagination: {
                    limit: options.limit,
                    hasMore,
                    nextCursor: hasMore ? data[data.length - 1].id : null,
                },
            };
        } catch (e) {
            log.error(`unknown error listing users: ${JSON.stringify(e)}`);
            throw new DbError({
                status: ErrorType.Unknown,
                isUserFault: false,
                message: `unknown error: ${e}`
            });
        }
    }
}
