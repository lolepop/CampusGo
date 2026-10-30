import { withTracedTransaction } from "../prisma/transaction.ts";
import { withDatabaseOperation } from "../telemetry/database.ts";
import { db } from "../prisma/db.ts";
import { OutboxRepository } from "../prisma/outbox.ts";
import { userExists } from "../queue/impl/rpc.ts";

export async function resolveCreditAccount(userId: number): Promise<boolean> {
    const credits = await withDatabaseOperation("database.UserCredits.first", async () => db.orm.public.UserCredits.where({ userId }).first());
    if (credits) return true;
    if (!await userExists(userId)) return false;
    await ensureCreditAccount(userId);
    return true;
}

// Do the remote lookup before taking transaction locks.
export async function resolveHoldCreditAccount(errandId: string, role: "courierId" | "requestorId") {
    const hold = await withDatabaseOperation("database.CreditsOnHold.first", async () => db.orm.public.CreditsOnHold.where({ errandId }).first());
    const userId = hold?.[role];
    if (hold?.status === "HELD" && userId != null) {
        await resolveCreditAccount(userId);
    }
}

export async function ensureCreditAccount(userId: number): Promise<void> {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw new Error("User ID must be a positive integer");
    }

    // Duplicate deliveries must not reset an existing account's balance.
    // Other database errors propagate to the consumer.
    await withDatabaseOperation("database.UserCredits.createAll", async () => db.orm.public.UserCredits.createAll(
        [{ userId, balance: 100 }],
        { onConflict: "skip" },
    ));
}

export async function ensureCreditsHeld(errandId: string, requestorId: number, amount: number): Promise<void> {
    await resolveCreditAccount(requestorId);
    try {
        await withTracedTransaction(db, async tx => {
            const outbox = new OutboxRepository(tx);

            const credits = await withDatabaseOperation("database.UserCredits.first", async () => tx.orm.public.UserCredits
            .where({userId: requestorId })
            .forUpdate()
            .first())

            if (!credits) {
                await outbox.createEvent("credits.hold.rejected", "creditsHoldRejected", {
                    errandId,
                    reason: "REQUESTOR_NOT_FOUND",
                    occurredAt: new Date().toISOString(),
                });
                // emit new event to order service using rabbitmq
                // errandId, error
                return;
            }

            const existingHold = await withDatabaseOperation("database.CreditsOnHold.first", async () => tx.orm.public.CreditsOnHold
                .where({ errandId })
                .first());

            if (existingHold) {
                if (
                    existingHold.requestorId !== requestorId ||
                    existingHold.amount !== amount
                ) {
                    await outbox.createEvent("credits.hold.rejected", "creditsHoldRejected", {
                        errandId,
                        reason: "RECORD_NOT_MATCHING",
                        occurredAt: new Date().toISOString(),
                    });
                }

                return; // Already processed; do not deduct again.
            }

            if (credits.balance < amount) {
                await outbox.createEvent("credits.hold.rejected", "creditsHoldRejected", {
                    errandId,
                    reason: "INSUFFICIENT_CREDITS",
                    occurredAt: new Date().toISOString(),
                });
                return;
            }

            await withDatabaseOperation("database.CreditsOnHold.create", async () => tx.orm.public.CreditsOnHold.create(
                { errandId, requestorId, amount, status: "HELD" }
            ))

            await withDatabaseOperation("database.UserCredits.update", async () => tx.orm.public.UserCredits
                .where({ userId: requestorId })
                .update({ balance: credits.balance - amount }))

            // emit new event order created successfully
            // errandId
            await outbox.createEvent("credits.held", "creditsHeld", {
                errandId,
                occurredAt: new Date().toISOString(),
            })
        })
    } catch (error) {
        // Let the consumer handle failures without acknowledging the event.
        throw error;
    }
}

export async function ensureCreditsAccepted(errandId: string, courierId: number): Promise<void> {
    await resolveCreditAccount(courierId);
    await withTracedTransaction(db, async tx => {
        const outbox = new OutboxRepository(tx);
        const reject = async (reason: string) => {
            await outbox.createEvent("credits.accepted.rejected", "creditsAcceptedRejected", {
                errandId,
                reason,
                occurredAt: new Date().toISOString(),
            });
        };

        const hold = await withDatabaseOperation("database.CreditsOnHold.first", async () => tx.orm.public.CreditsOnHold
            .where({ errandId })
            .forUpdate()
            .first());

        if (!hold) {
            await reject("ERRAND_NOT_FOUND");
            return;
        }

        if (hold.courierId === courierId) {
            return; // Already processed; do not emit another acceptance event.
        }

        if (hold.status !== "HELD") {
            await reject(hold.status === "REFUNDED" ? "HOLD_ALREADY_REFUNDED" : "HOLD_ALREADY_RELEASED");
            return;
        }

        if (hold.courierId !== null) {
            await reject("RECORD_NOT_MATCHING");
            return;
        }

        const courier = await withDatabaseOperation("database.UserCredits.first", async () => tx.orm.public.UserCredits
            .where({ userId: courierId })
            .first());

        if (!courier) {
            await reject("COURIER_NOT_FOUND");
            return;
        }

        await withDatabaseOperation("database.CreditsOnHold.update", async () => tx.orm.public.CreditsOnHold
            .where({ errandId })
            .update({ courierId }));

        await outbox.createEvent("credits.accepted", "creditsAccepted", {
            errandId,
            occurredAt: new Date().toISOString(),
        });
    });
}

export async function ensureCreditsReleased(errandId: string) {
    await resolveHoldCreditAccount(errandId, "courierId");
    try {
        await withTracedTransaction(db, async tx => {
            const outbox = new OutboxRepository(tx);

            const hold = await withDatabaseOperation("database.CreditsOnHold.first", async () => tx.orm.public.CreditsOnHold
                .where({ errandId: errandId })
                .forUpdate()
                .first())
            
            if (!hold) {
                await outbox.createEvent("credits.released.rejected", "creditsReleasedRejected", {
                    errandId,
                    reason: "ERRAND_NOT_FOUND",
                    occurredAt: new Date().toISOString(),
                });
                return;
            }
            
            const { courierId, amount, status } = hold 

            if (status === "RELEASED") {
                return;
            }

            if (status !== "HELD") {
                await outbox.createEvent("credits.released.rejected", "creditsReleasedRejected", {
                    errandId,
                    reason: "HOLD_ALREADY_REFUNDED",
                    occurredAt: new Date().toISOString(),
                });
                return;
            }

            const courier = await withDatabaseOperation("database.UserCredits.first", async () => tx.orm.public.UserCredits
                .where({ userId: courierId })
                .forUpdate()
                .first())

            if (!courier) {
                await outbox.createEvent("credits.released.rejected", "creditsReleasedRejected", {
                    errandId,
                    reason: "COURIER_NOT_FOUND",
                    occurredAt: new Date().toISOString(),
                })
                return;
            }
            
            await withDatabaseOperation("database.UserCredits.update", async () => tx.orm.public.UserCredits
                .where({ userId: courierId })
                .update({ balance: courier.balance + amount }))

            await withDatabaseOperation("database.CreditsOnHold.update", async () => tx.orm.public.CreditsOnHold
                .where({ errandId: errandId })
                .update({ status: "RELEASED" }))

            await outbox.createEvent("credits.released", "creditsReleased", {
                errandId,
                occurredAt: new Date().toISOString(),
            });
        })
    }
    catch (error) {
    // Let the consumer handle failures without acknowledging the event.
        throw error;
    }
}

export async function ensureCreditsRefunded(errandId: string) {
    await resolveHoldCreditAccount(errandId, "requestorId");
    try {
        await withTracedTransaction(db, async tx => {
            const outbox = new OutboxRepository(tx);

            const hold = await withDatabaseOperation("database.CreditsOnHold.first", async () => tx.orm.public.CreditsOnHold
                .where({ errandId: errandId })
                .forUpdate()
                .first())
            
            if (!hold) {
                await outbox.createEvent("credits.refunded.rejected", "creditsRefundedRejected", {
                    errandId,
                    reason: "ERRAND_NOT_FOUND",
                    occurredAt: new Date().toISOString(),
                });
                return;
            }
            
            const { requestorId, amount, status } = hold 

            if (status === "REFUNDED") {
                return;
            }

            if (status !== "HELD") {
                await outbox.createEvent("credits.refunded.rejected", "creditsRefundedRejected", {
                    errandId,
                    reason: "HOLD_ALREADY_RELEASED",
                    occurredAt: new Date().toISOString(),
                });
                return;
            }

            const requestor = await withDatabaseOperation("database.UserCredits.first", async () => tx.orm.public.UserCredits
                .where({ userId: requestorId })
                .forUpdate()
                .first())

            if (!requestor) {
                await outbox.createEvent("credits.refunded.rejected", "creditsRefundedRejected", {
                    errandId,
                    reason: "REQUESTOR_NOT_FOUND",
                    occurredAt: new Date().toISOString(),
                })
                return;
            }
            
            await withDatabaseOperation("database.UserCredits.update", async () => tx.orm.public.UserCredits
                .where({ userId: requestorId })
                .update({ balance: requestor.balance + amount }))

            await withDatabaseOperation("database.CreditsOnHold.update", async () => tx.orm.public.CreditsOnHold
                .where({ errandId: errandId })
                .update({ status: "REFUNDED" }))

            await outbox.createEvent("credits.refunded", "creditsRefunded", {
                errandId,
                occurredAt: new Date().toISOString(),
            });
        })
    }
    catch (error) {
    // Let the consumer handle failures without acknowledging the event.
        throw error;
    }
}
