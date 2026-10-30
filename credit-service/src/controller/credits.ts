import { isExpectedDbError, recordError } from "../telemetry/tracing.ts";
import { withTracedTransaction } from "../prisma/transaction.ts";
import { withDatabaseOperation } from "../telemetry/database.ts";
import log from "../log.ts";
import type { RouterContext } from "@oak/oak";
import type { Context } from "@oak/oak";
import { db } from "../prisma/db.ts";
import type { AuthenticatedUser } from "../middleware/auth.ts";
import { resolveCreditAccount, resolveHoldCreditAccount } from "../services/credits.ts";

function validateId(ctx: Context, id: number): boolean {
    if (!Number.isInteger(id) || id <= 0) {
        ctx.response.status = 400;
        ctx.response.body = {
            error: "Supplier ID must be a positive integer"
        }
        return false;
    }
    return true;
}

function validateErrandId(ctx: Context, errandId: string): boolean {
    if (typeof errandId !== "string" || errandId.trim() === "") {
        ctx.response.status = 400;
        ctx.response.body = { error: "Errand ID must be a non-empty string" };
        return false;
    }
    return true;
}

export const getBalance = async (ctx: Context, userId: number) => {
    if (!validateId(ctx, userId)) return;
    try {
        await resolveCreditAccount(userId);
        const balance = await withDatabaseOperation("database.UserCredits.first", async () => db.orm.public.UserCredits
            .where({ userId: userId })
            .first());
            ctx.response.status = 200;
            ctx.response.body = balance;

        if (!balance) {
            ctx.response.status = 404;
            ctx.response.body = { error: "User credit balance not found" };
            return;
        }
    } catch (error) {
        if (!isExpectedDbError(error)) recordError(error);
        log.error("Failed to fetch credits:", error);
        ctx.response.status = 500;
        ctx.response.body = { 
            error: "Internal server error" 
        }
    }
}

export const listTransactions = async (ctx: Context, userId: number) => {
    if (!validateId(ctx, userId)) return;
    try {
        if (!await resolveCreditAccount(userId)) {
            ctx.response.status = 404;
            ctx.response.body = { error: "User not found" };
            return;
        }
        const balance = await withDatabaseOperation("database.CreditsOnHold.all", async () => db.orm.public.CreditsOnHold
            .where({ requestorId: userId })
            .all());
            ctx.response.status = 200;
            ctx.response.body = balance;
    } catch (error) {
        if (!isExpectedDbError(error)) recordError(error);
        log.error("Failed to fetch credits:", error);
        ctx.response.status = 500;
        ctx.response.body = { 
            error: "Internal server error" 
        }
    }
}

export const registerUser = async (ctx: Context, userId: number) => {
    if (!validateId(ctx, userId)) return;
    try {
        if (await withDatabaseOperation("database.UserCredits.first", async () => db.orm.public.UserCredits.where({ userId }).first())) {
            ctx.response.status = 409;
            ctx.response.body = { error: "User credit account already exists" };
            return;
        }
        if (!await resolveCreditAccount(userId)) {
            ctx.response.status = 404;
            ctx.response.body = { error: "User not found" };
            return;
        }
        const userCredits = await withDatabaseOperation("database.UserCredits.first", async () => db.orm.public.UserCredits.where({ userId }).first());
        ctx.response.status = 201;
        ctx.response.body = userCredits;
    } catch (error) {
        if (!isExpectedDbError(error)) recordError(error);
        if ((error as { sqlState?: string })?.sqlState === "23505") {
            ctx.response.status = 409;
            ctx.response.body = { error: "User credit account already exists" };
            return;
        }
        log.error("Failed to register credit account:", error);
        ctx.response.status = 500;
        ctx.response.body = { error: "Internal server error" };
    }
}

export const releaseCredits = async (ctx: Context, errandId: string) => {
    if (!validateErrandId(ctx, errandId)) return;

    try {
        await resolveHoldCreditAccount(errandId, "courierId");
        const result = await withTracedTransaction(db, async tx => {
            const hold = await withDatabaseOperation("database.CreditsOnHold.first", async () => tx.orm.public.CreditsOnHold
                .where({ errandId })
                .forUpdate()
                .first());

            if (!hold) {
                ctx.throw(404, "Credit hold not found");
            }
            if (hold.status !== "HELD") {
                ctx.throw(409, "Credit hold has already been settled");
            }

            if (hold.courierId === null) {
                ctx.throw(409, "No courier has been assigned to this errand");
            }

            const credits = await withDatabaseOperation("database.UserCredits.first", async () => tx.orm.public.UserCredits
                .where({ userId: hold.courierId })
                .forUpdate()
                .first());

            if (!credits) {
                ctx.throw(404, "Supplier credit balance not found");
            }

            const userCredits = await withDatabaseOperation("database.UserCredits.update", async () => tx.orm.public.UserCredits
                .where({ userId: hold.courierId })
                .update({ balance: credits.balance + hold.amount }));

            const releasedHold = await withDatabaseOperation("database.CreditsOnHold.update", async () => tx.orm.public.CreditsOnHold
                .where({ errandId })
                .update({ status: "RELEASED" }));

            return { hold: releasedHold, userCredits };
        });

        ctx.response.status = 200;
        ctx.response.body = result;
    } catch (error) {
        if (!isExpectedDbError(error)) recordError(error);
        // Preserve HTTP errors such as 404 and 409.
        if (error instanceof Error && "status" in error) {
            throw error;
        }

        log.error("Failed to release credits:", error);
        ctx.response.status = 500;
        ctx.response.body = { error: "Internal server error" };
    }
};

export const refundCredits = async (ctx: Context, errandId: string) => {
    if (!validateErrandId(ctx, errandId)) return;

    try {
        await resolveHoldCreditAccount(errandId, "requestorId");
        const result = await withTracedTransaction(db, async tx => {
            const hold = await withDatabaseOperation("database.CreditsOnHold.first", async () => tx.orm.public.CreditsOnHold
                .where({ errandId })
                .forUpdate()
                .first());

            if (!hold) {
                ctx.throw(404, "Credit hold not found");
            }
            if (hold.status !== "HELD") {
                ctx.throw(409, "Credit hold has already been settled");
            }

            const credits = await withDatabaseOperation("database.UserCredits.first", async () => tx.orm.public.UserCredits
                .where({ userId: hold.requestorId })
                .forUpdate()
                .first());

            if (!credits) {
                ctx.throw(404, "Requester credit balance not found");
            }

            const userCredits = await withDatabaseOperation("database.UserCredits.update", async () => tx.orm.public.UserCredits
                .where({ userId: hold.requestorId })
                .update({ balance: credits.balance + hold.amount }));

            const refundedHold = await withDatabaseOperation("database.CreditsOnHold.update", async () => tx.orm.public.CreditsOnHold
                .where({ errandId })
                .update({ status: "REFUNDED" }));

            return { hold: refundedHold, userCredits };
        });

        ctx.response.status = 200;
        ctx.response.body = result;
    } catch (error) {
        if (!isExpectedDbError(error)) recordError(error);
        // Preserve HTTP errors such as 404 and 409.
        if (error instanceof Error && "status" in error) {
            throw error;
        }

        log.error("Failed to refund credits:", error);
        ctx.response.status = 500;
        ctx.response.body = { error: "Internal server error" };
    }
};

export const createTransaction = async (ctx: Context) => {
    let body;
    try {
        body = await ctx.request.body.json();
    } catch {
        ctx.response.status = 400;
        ctx.response.body = { error: "Request expected JSON body" };
        return;
    }

    const isPgInt = (value: unknown) =>
        Number.isInteger(value) && (value as number) > 0 && (value as number) <= 2_147_483_647;

    if (!body
        || typeof body.errandId !== "string" || body.errandId.trim() === ""
        || !isPgInt(body.requesterId)
        || !isPgInt(body.amount)
        || (body.supplierId != null && !isPgInt(body.supplierId))) {
        ctx.response.status = 400;
        ctx.response.body = { error: "errandId must be a non-empty string; requesterId and amount must be positive PostgreSQL integers; supplierId is optional" };
        return;
    }

    const { errandId, requesterId, amount } = body;
    const supplierId: number | null = body.supplierId ?? null;

    try {
        await resolveCreditAccount(requesterId);
        await resolveCreditAccount(supplierId);
        const result = await withTracedTransaction(db, async tx => {
            const credits = await withDatabaseOperation("database.UserCredits.first", async () => tx.orm.public.UserCredits
                .where({ userId: requesterId })
                .forUpdate()
                .first());

            if (!credits) {
                ctx.throw(404, "Requester credit balance not found");
            }

            const existingHold = await withDatabaseOperation("database.CreditsOnHold.first", async () => tx.orm.public.CreditsOnHold
                .where({ errandId })
                .first());
            if (existingHold) {
                ctx.throw(409, "A credit hold already exists for this errand");
            }
            if (credits.balance < amount) {
                ctx.throw(409, "Insufficient credits");
            }

            if (supplierId !== null) {
                const supplierCredits = await withDatabaseOperation("database.UserCredits.first", async () => tx.orm.public.UserCredits
                    .where({ userId: supplierId })
                    .first());
                if (!supplierCredits) {
                    ctx.throw(404, "Supplier credit balance not found");
                }
            }

            const hold = await withDatabaseOperation("database.CreditsOnHold.create", async () => tx.orm.public.CreditsOnHold.create({
                errandId,
                requestorId: requesterId,
                courierId: supplierId,
                amount,
                status: "HELD",
            }));

            const userCredits = await withDatabaseOperation("database.UserCredits.update", async () => tx.orm.public.UserCredits
                .where({ userId: requesterId })
                .update({ balance: credits.balance - amount }));

            return { hold, userCredits };
        });

        ctx.response.status = 201;
        ctx.response.body = result;
    } catch (error) {
        if (!isExpectedDbError(error)) recordError(error);
        if (error instanceof Error && "status" in error) {
            throw error;
        }

        log.error("Failed to create credit hold:", error);
        ctx.response.status = 500;
        ctx.response.body = { error: "Internal server error" };
    }
};