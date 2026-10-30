import { recordError } from "../telemetry/tracing.ts";
import type { Context, RouterContext } from "@oak/oak";
import config from "../config.ts";
import log from "../log.ts";
import { Role } from "../common.ts";
import type { AuthenticatedUser } from "../middleware/auth.ts";
import type { CreateOrderBody, ListOrdersQuery, UpdateOrderStatusBody } from "../schema/order.ts";
import { describeBuildingSpot, fetchBuildingNames, lookupPickup } from "../util/supplierService.ts";
import {
    createOrder as insertOrder,
    expireDueOrders,
    findOrderById,
    findOrderByIdempotencyKey,
    listOrders,
    transitionOrder,
    type NewOrder,
    type Order,
} from "../prisma/orders.ts";
import { orderAcceptedEvent, orderRefundedEvent, orderReleasedEvent } from "../rabbitmq/events.ts";

const respond = (ctx: Context, status: number, body: Context["response"]["body"]) => {
    ctx.response.status = status;
    ctx.response.body = body;
};

const internalError = (ctx: Context, action: string, e: unknown) => {
    recordError(e);
    log.error(`failed to ${action}: ${e} (origin: ${(<Error>e)?.stack})`);
    respond(ctx, 500, { error: `Failed to ${action}` });
};

/**
 * Waits indefinitely for credit service to respond before changing PENDING to OPEN or REJECTED. 
 * Refunds for both are queued as order.refunded events in the same
 * transaction as the status change, so no requester is left without their credits.
 * Run by the background job, and before reading or changing orders so nobody sees or acts
 * on an order that should already have expired.
 */
export const expireDueErrands = async (): Promise<void> => {
    const expired = await expireDueOrders();
    for (const o of expired)
        log.info(`Order ${o.id} EXPIRED, refund requested`);
};

/**
 * GET /orders: one page of orders for a scope, newest first
 *   ?scope=open (default)  errands a courier can accept: open, not expired, not your own
 *   ?scope=requested       errands you created
 *   ?scope=delivering      errands you are the courier on
 *   ?scope=all             every order, admins only
 *   &status=A,B            only these statuses, e.g. DELIVERED,CANCELLED,EXPIRED for past orders
 *   &page=N                20 per page
 *   &userId=N              admins only: the requested or delivering errands of user N instead of your own
 */
export const fetchOrders = async (ctx: Context) => {
    // set by validateQuery(listOrdersQuerySchema) and authenticationMiddleware in routes
    const query = <ListOrdersQuery>ctx.state.validatedQuery;
    const user = <AuthenticatedUser>ctx.state.user;

    const isAdmin = user.roles.includes(Role.Admin);
    if (query.scope === "all" && !isAdmin) {
        respond(ctx, 403, { error: "Only admins can list every order" });
        return;
    }
    if (query.userId !== undefined && !isAdmin) {
        respond(ctx, 403, { error: "Only admins can list another user's orders" });
        return;
    }

    try {
        // so lists never show an errand that should have expired as still active
        await expireDueErrands();

        const limit = config.order.pageSize;
        const { data, total } = await listOrders({
            scope: query.scope,
            // an admin viewing someone's history, otherwise the signed-in user
            userId: query.userId ?? user.id,
            statuses: query.status,
            page: query.page,
            pageSize: limit,
        });

        // same response shape as the supplier list
        respond(ctx, 200, {
            data,
            pagination: {
                page: query.page,
                limit,
                total,
                totalPage: Math.ceil(total / limit),
            },
        });
    } catch (e) {
        internalError(ctx, "fetch orders", e);
    }
};

/**
 * GET /orders/:id: one order, e.g. for the errand details and progress screen.
 * The requester, the assigned courier and admins can always see it. Anyone else only
 * while it is OPEN, so couriers can look before accepting; otherwise 404,
 * so other people's ongoing and past errands (and their dropoff locations) stay private.
 */
export const fetchOrder = async (ctx: RouterContext<"/:id">) => {
    const user = <AuthenticatedUser>ctx.state.user;

    try {
        await expireDueErrands();
        const order = await findOrderById(ctx.params.id);

        const canSee = order !== null && (
            order.requesterId === user.id ||
            order.courierId === user.id ||
            user.roles.includes(Role.Admin) ||
            order.status === "OPEN"
        );
        if (!canSee) {
            respond(ctx, 404, { error: "Order not found" });
            return;
        }

        respond(ctx, 200, order);
    } catch (e) {
        internalError(ctx, "fetch order", e);
    }
};

/**
 * POST /orders: the signed-in user creates an errand.
 * Sending the same Idempotency-Key again returns the existing order instead of creating a duplicate.
 */
export const createOrder = async (ctx: Context) => {
    // set by validateBody(createOrderSchema) and authenticationMiddleware in routes
    const body = <CreateOrderBody>ctx.state.validatedBody;
    const user = <AuthenticatedUser>ctx.state.user;
    const idempotencyKey = ctx.request.headers.get("Idempotency-Key");

    try {
        // 1. idempotency check
        if (idempotencyKey) {
            const existing = await findOrderByIdempotencyKey(idempotencyKey);
            if (existing) {
                respond(ctx, 200, { order: existing, deduplicated: true });
                return;
            }
        }

        // 2. the pickup supplier and the buildings must be live; their names go into the
        //    readable pickup and dropoff locations
        const authorization = ctx.request.headers.get("authorization") ?? "";
        const unavailable = () => respond(ctx, 503, { error: "Supplier service is unavailable, try again later" });
        const buildingNames = await fetchBuildingNames(authorization);
        if (!buildingNames) {
            unavailable();
            return;
        }

        const notFound: Record<string, string[]> = {};
        const dropoffBuilding = buildingNames.get(body.dropoffLocationId);
        if (!dropoffBuilding)
            notFound.dropoffLocationId = ["Building not found"];

        let pickup: NewOrder["pickup"] | null = null;
        let pickupLocation = "";
        if (body.pickupType === "SUPPLIER") {
            // a supplier is a preset building spot: its building and floor fill in the pickup fields
            const supplier = await lookupPickup(body.supplierId!, authorization);
            if (supplier.found) {
                pickup = { type: "SUPPLIER", supplierId: body.supplierId!, locationId: supplier.locationId, floor: supplier.floor };
                pickupLocation = supplier.pickupLocation;
            } else if (supplier.reason === "NOT_FOUND")
                notFound.supplierId = ["Supplier not found"];
            else {
                unavailable();
                return;
            }
        } else {
            pickup = {
                type: "BUILDING",
                locationId: body.pickupLocationId!,
                floor: body.pickupFloor!,
                room: body.pickupRoom ?? null,
            };
            const building = buildingNames.get(pickup.locationId);
            if (building)
                pickupLocation = describeBuildingSpot(building, pickup.floor, pickup.room);
            else
                notFound.pickupLocationId = ["Building not found"];
        }

        if (Object.keys(notFound).length > 0 || !pickup) {
            respond(ctx, 400, { error: "invalid request body", fields: notFound });
            return;
        }

        const dropoff = {
            locationId: body.dropoffLocationId,
            floor: body.dropoffFloor,
            room: body.dropoffRoom ?? null,
        };

        // 3. persist as PENDING; the requester is whoever is signed in, never taken from the body
        let order: Order;
        try {
            order = await insertOrder({
                idempotencyKey,
                requesterId: user.id,
                pickup,
                dropoff,
                pickupLocation,
                dropoffLocation: describeBuildingSpot(dropoffBuilding!, dropoff.floor, dropoff.room),
                itemDescription: body.itemDescription,
                creditBounty: body.creditBounty,
                additionalDetails: body.additionalDetails || null,
                // waits for a courier for the chosen duration, or the default
                expiresAt: new Date(Date.now() + (body.expiresInMinutes ?? config.order.expiry.defaultMinutes) * 60_000),
            });
        } catch (e) {
            // two requests with the same Idempotency-Key at the same moment: the unique key
            // lets only one insert succeed, the other returns the order that was created
            const existing = idempotencyKey ? await findOrderByIdempotencyKey(idempotencyKey) : null;
            if (!existing)
                throw e;
            respond(ctx, 200, { order: existing, deduplicated: true });
            return;
        }

        // The credit hold happens asynchronously (order.created -> credits.held / credits.hold.rejected).
        // The order is PENDING until then; clients poll it and see OPEN or REJECTED.
        respond(ctx, 201, order);
    } catch (e) {
        internalError(ctx, "create order", e);
    }
};

/**
 * PATCH /orders/:id/status: moves an order along its lifecycle
 *   OPEN -> ACCEPTED -> COLLECTED -> DELIVERED
 *   OPEN or ACCEPTED -> CANCELLED (by the requester; never once collected, by anyone)
 *   -> EXPIRED is only set by the service (see expireDueOrders)
 * The requester and courier share one deadline: the courier must collect the item,
 * and deliver it, before it; at the deadline any unfinished errand expires.
 * Each change is a single conditional UPDATE (see transitionOrder), so two requests
 * racing on the same order cannot both succeed.
 */
export const updateOrderStatus = async (ctx: RouterContext<"/:id/status">) => {
    const { targetStatus } = <UpdateOrderStatusBody>ctx.state.validatedBody;
    // the caller comes from the access token, never from the body
    const user = <AuthenticatedUser>ctx.state.user;
    const callerId = user.id;
    const orderId = ctx.params.id;

    // returned when the order changed between reading it and updating it
    const changedMeanwhile = () => respond(ctx, 409, { error: "Order was updated by someone else, refresh and try again" });

    try {
        // 1. expire anything due, so a late action gets a clear answer instead of succeeding
        await expireDueErrands();
        const order = await findOrderById(orderId);
        if (!order) {
            respond(ctx, 404, { error: "Order not found" });
            return;
        }
        if (order.status === "EXPIRED") {
            respond(ctx, 410, { error: "Order has expired" });
            return;
        }

        // 2. authorization & transition rules
        let updated: Order | null;
        switch (targetStatus) {
            case "ACCEPTED": {
                if (order.status !== "OPEN") {
                    respond(ctx, 409, { error: `Cannot accept order in status ${order.status}` });
                    return;
                }
                if (callerId === order.requesterId) {
                    respond(ctx, 403, { error: "Requester cannot accept their own errand" });
                    return;
                }

                // concurrency guard: only one courier's update can match status OPEN.
                // order.accepted (tells Credit who to pay) is queued in the same transaction
                updated = await transitionOrder(orderId, {
                    from: "OPEN",
                    to: "ACCEPTED",
                    courierId: callerId,
                    beforeDeadline: true,
                }, o => [orderAcceptedEvent(o)]);
                if (!updated) {
                    // another courier accepted it, or the requester cancelled it, or it expired, a moment earlier
                    respond(ctx, 409, { error: "Order is no longer open: another courier accepted it, or it was cancelled or expired" });
                    return;
                }
                break;
            }

            case "COLLECTED": {
                if (order.status !== "ACCEPTED") {
                    respond(ctx, 400, { error: `Cannot mark collected from status ${order.status}` });
                    return;
                }
                if (callerId !== order.courierId) {
                    respond(ctx, 403, { error: "Only the assigned courier can mark the item as collected" });
                    return;
                }

                // the item must be collected before the deadline
                updated = await transitionOrder(orderId, { from: "ACCEPTED", to: "COLLECTED", beforeDeadline: true });
                if (!updated) {
                    changedMeanwhile();
                    return;
                }
                break;
            }

            case "DELIVERED": {
                if (callerId !== order.courierId) {
                    respond(ctx, 403, { error: "Only the assigned courier can mark the errand as delivered" });
                    return;
                }
                // a repeated request (double tap, retry) succeeds without paying again
                if (order.status === "DELIVERED") {
                    respond(ctx, 200, order);
                    return;
                }
                if (order.status !== "COLLECTED") {
                    respond(ctx, 400, { error: "Cannot mark delivered before the item is collected" });
                    return;
                }

                // the item must be delivered before the deadline. order.released (pay the courier) is
                // queued in the same transaction, only by the request whose update wins, so two
                // requests at the same moment cannot pay twice
                updated = await transitionOrder(
                    orderId,
                    { from: "COLLECTED", to: "DELIVERED", beforeDeadline: true },
                    o => [orderReleasedEvent(o)],
                );
                if (!updated) {
                    // the other request delivered it first: same outcome, already paid
                    const current = await findOrderById(orderId);
                    if (current?.status === "DELIVERED") {
                        respond(ctx, 200, current);
                        return;
                    }
                    changedMeanwhile();
                    return;
                }
                break;
            }

            case "CANCELLED": {
                if (callerId !== order.requesterId) {
                    respond(ctx, 403, { error: "Only the requester can cancel this errand" });
                    return;
                }
                // once the courier has the item, nobody can cancel: it ends as DELIVERED or EXPIRED
                if (order.status !== "OPEN" && order.status !== "ACCEPTED") {
                    respond(ctx, 400, { error: `Cannot cancel an order in ${order.status} state` });
                    return;
                }

                // only if it is still in the status that was read: a courier accepting or collecting at
                // the same moment makes this match nothing. order.refunded (give the hold back) is
                // queued in the same transaction, so the refund happens exactly when the cancel does
                updated = await transitionOrder(
                    orderId,
                    { from: order.status, to: "CANCELLED" },
                    o => [orderRefundedEvent(o)],
                );
                if (!updated) {
                    changedMeanwhile();
                    return;
                }
                break;
            }
        }

        respond(ctx, 200, updated);
    } catch (e) {
        internalError(ctx, "update order status", e);
    }
};
