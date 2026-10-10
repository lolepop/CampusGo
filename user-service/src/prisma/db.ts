import postgres from "@prisma/orm-postgres/runtime";

import type { Contract } from "./contract.d.ts";
import contractJson from "./contract.json" with { type: "json" };
import log from "../log.ts";
import config from "../config.ts";

const databaseUrl = config.dbConnectionString;
if (!databaseUrl) {
    log.warn("DATABASE_URL is not set, no connection to the database will be made");
  // throw new Error("DATABASE_URL is not set. Add it to .env before starting the app.");
}

export const db = postgres<Contract>({ contractJson, url: databaseUrl });

export type Db = ReturnType<typeof postgres<Contract>>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]; // why is this not an exposed type

/// database type that may either be a full db type or a transaction type (subset)
export type DbTxUnion = Db | Tx;

/// runtime check to separate the union
/// only the main db type has the transaction function
export function isTransaction(ctx: DbTxUnion): ctx is Tx {
    return !("transaction" in ctx) || typeof ctx.transaction !== "function";
}

let connection: Promise<void> | undefined;

// ensure connection happens, invocation not required due to lazy db init
export function connectDatabase(): Promise<void> {
    if (!databaseUrl)
        return Promise.resolve();
    connection ??= db.connect().then(() => undefined).catch((error: unknown) => {
        connection = undefined;
        throw error;
    });
    return connection;
}
