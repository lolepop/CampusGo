import { SpanKind } from "@opentelemetry/api";
import { captureTraceContext, extractTraceContext } from "../telemetry/propagation.ts";
import { withMessagingSpan } from "../telemetry/messaging.ts";
import { recordError } from "../telemetry/tracing.ts";
import { rabbitAvailable, rabbitTransitions } from "../telemetry/queue.ts";
// src/rabbitmq/client.ts
// Connection, topology, consumer (Credit -> Order replies) and the confirmed publish used by
// the outbox worker. Nothing else in the service talks to RabbitMQ directly.
import amqplib from "amqplib";
import config from "../config.ts";
import log from "../log.ts";
import { findOrderById, transitionOrder } from "../prisma/orders.ts";
import { enqueueEventsAlone } from "../prisma/outbox.ts";
import { EXCHANGE, ROUTING, orderRefundedEvent } from "./events.ts";
import type { CreditsHeldEvent, CreditsRejectionEvent } from "./events.ts";

const QUEUE_NAME = "order.events.queue";
const DLX_NAME = "app.dlx"; // same dead-letter exchange the credit service declares (topic)
const DLQ_NAME = "order.events.dlq";
const REPLY_KEYS = [
    ROUTING.creditsHeld,
    ROUTING.creditsHoldRejected,
    ROUTING.creditsAccepted,
    ROUTING.creditsAcceptedRejected,
    ROUTING.creditsReleased,
    ROUTING.creditsReleasedRejected,
    ROUTING.creditsRefunded,
    ROUTING.creditsRefundedRejected,
];

let channel: amqplib.ConfirmChannel | undefined;
let opened = false;
let telemetryConnected = false;
rabbitAvailable.record(0);
// messageIds the broker handed back because no queue was bound to the routing key
let returned = new Set<string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const isConnected = () => channel !== undefined;

/** connection diagnostics metrics */
const observeConnection = (up: boolean) => {
    if (up === telemetryConnected) return;
    telemetryConnected = up;
    rabbitAvailable.record(up ? 1 : 0);
    if (up) {
        if (opened) rabbitTransitions.add(1, { transition: "reconnect" });
        opened = true;
    } else {
        rabbitTransitions.add(1, { transition: "disconnect" });
    }
};

const setup = async () => {
    const connection = await amqplib.connect(config.rabbitMqUrl!);
    connection.on("error", (e: unknown) => log.error(`RabbitMQ connection error: ${e}`));

    try {
        const ch = await connection.createConfirmChannel();
        ch.on("close", () => observeConnection(false));
        ch.on("error", (e: unknown) => log.error(`RabbitMQ channel error: ${e}`));
        returned = new Set();
        ch.on("return", (m: amqplib.Message) => {
            if (m.properties.messageId) returned.add(m.properties.messageId);
        });

        // same name and type as the credit service, otherwise the declare fails
        await ch.assertExchange(EXCHANGE, "topic", { durable: true });
        await ch.assertExchange(DLX_NAME, "topic", { durable: true });

        // messages that keep failing land here instead of being lost
        await ch.assertQueue(DLQ_NAME, { durable: true });
        await ch.bindQueue(DLQ_NAME, DLX_NAME, QUEUE_NAME);

        await ch.assertQueue(QUEUE_NAME, {
            durable: true,
            deadLetterExchange: DLX_NAME,
            deadLetterRoutingKey: QUEUE_NAME,
        });
        for (const key of REPLY_KEYS) await ch.bindQueue(QUEUE_NAME, EXCHANGE, key);

        await ch.prefetch(10);
        await ch.consume(QUEUE_NAME, async (msg) => {
            if (!msg) return;
            await withMessagingSpan("process", QUEUE_NAME, SpanKind.CONSUMER, async () => {
                try {
                    await handleIncomingMessage(msg);
                    ch.ack(msg);
                } catch (error) {
                    recordError(error);
                    // first failure: requeue once; second failure: dead-letter
                    log.error(`Failed to process ${msg.fields.routingKey}: ${error}`);
                    ch.nack(msg, false, !msg.fields.redelivered);
                }
            }, extractTraceContext(msg.properties.headers));
        });

        connection.on("close", () => {
            observeConnection(false);
            channel = undefined;
            log.warn("RabbitMQ connection closed, reconnecting");
            void connectRabbitMQ();
        });
        channel = ch;
        observeConnection(true);
    } catch (error) {
        await connection.close().catch(() => {});
        throw error;
    }
};

/**
 * Connects with retry/backoff and keeps the consumer running.
 * Call it WITHOUT await so the HTTP server still starts if RabbitMQ is not up yet.
 */
export const connectRabbitMQ = async (): Promise<void> => {
    if (!config.rabbitMqUrl) {
        log.error("RABBITMQ_CONNECTION is not set; order events are disabled");
        return;
    }
    for (let attempt = 1; ; attempt++) {
        try {
            await setup();
            log.info("RabbitMQ connected. Order Service is listening for events.");
            return;
        } catch (error) {
            const delay = Math.min(1000 * 2 ** attempt, 15000);
            log.error(`RabbitMQ connect attempt ${attempt} failed: ${error}. Retrying in ${delay}ms`);
            await sleep(delay);
        }
    }
};

/**
 * Publishes and resolves only once the broker confirms it. Rejects if it is not connected, the
 * broker nacks it, or no queue is bound to the routing key (mandatory: the message would
 * otherwise be silently dropped, e.g. when the credit service has never started).
 */
export const publishEvent = (
    topic: string,
    type: string,
    payload: unknown,
    messageId: string,
): Promise<void> =>
    withMessagingSpan("publish", EXCHANGE, SpanKind.PRODUCER, async span => {
        span.setAttributes({ "messaging.message.id": messageId, "messaging.rabbitmq.destination.routing_key": topic });
        return await new Promise<void>((resolve, reject) => {
            const ch = channel;
            if (!ch) return reject(new Error("RabbitMQ is not connected"));
            const body = Buffer.from(JSON.stringify({ type, ...(payload as object) }));
            ch.publish(
                EXCHANGE,
                topic,
                body,
                { persistent: true, mandatory: true, contentType: "application/json", messageId, type, headers: captureTraceContext() },
                (err) => {
                    if (err) return reject(err);
                    if (returned.delete(messageId)) return reject(new Error(`unroutable: no queue bound to ${topic}`));
                    resolve();
                },
            );
        });
    });

const handleIncomingMessage = async (msg: amqplib.ConsumeMessage) => {
    const routingKey = msg.fields.routingKey;
    const payload = JSON.parse(msg.content.toString());
    const errandId = String(payload.errandId);
    log.info(`Received ${routingKey} for errand ${errandId}`);

    switch (routingKey) {
        case ROUTING.creditsHeld: {
            const o = await transitionOrder(errandId, { from: "PENDING", to: "OPEN" });
            if (o) {
                log.info(`Order ${o.id} is now OPEN`);
                break;
            }
            // Not PENDING any more: either a duplicate delivery (order is OPEN or further along),
            // or the order was rejected/cancelled/expired while Credit was still holding the money.
            // In the second case the hold is orphaned, so give it back (refunds are idempotent).
            const current = await findOrderById(errandId);
            if (current && ["REJECTED", "CANCELLED", "EXPIRED"].includes(current.status)) {
                log.warn(`credits.held for ${errandId} arrived but the order is ${current.status}; requesting a refund`);
                await enqueueEventsAlone([orderRefundedEvent(current)]);
            } else {
                log.info(`credits.held ignored for ${errandId} (duplicate or unknown order)`);
            }
            break;
        }
        case ROUTING.creditsHoldRejected: {
            const { reason } = payload as CreditsRejectionEvent;
            const o = await transitionOrder(errandId, { from: "PENDING", to: "REJECTED" });
            log.info(o ? `Order ${o.id} REJECTED: ${reason}` : `credits.hold.rejected ignored for ${errandId} (duplicate)`);
            break;
        }
        case ROUTING.creditsAccepted:
            log.info(`Credit recorded the courier for errand ${errandId}`);
            break;
        case ROUTING.creditsAcceptedRejected: {
            const { reason } = payload as CreditsRejectionEvent;
            // Only a problem with the courier is fixed by undoing the accept: another courier can
            // take the errand. Any other reason means the hold itself is wrong; that needs a human.
            if (reason === "COURIER_NOT_FOUND" || reason === "COURIER_ALREADY_ASSIGNED") {
                const o = await transitionOrder(errandId, { from: "ACCEPTED", to: "OPEN", clearCourier: true });
                if (o)
                    log.warn(`Accept undone for order ${o.id} (${reason}); it is OPEN again`);
                else
                    log.error(`credits.accepted.rejected for ${errandId} (${reason}) but the order is no longer ACCEPTED`);
            } else {
                log.error(`Credit refused the accept for errand ${errandId}: ${reason}`);
            }
            break;
        }
        case ROUTING.creditsReleased:
        case ROUTING.creditsRefunded:
            log.info(`Ledger closed for errand ${errandId} (${routingKey})`);
            break;
        case ROUTING.creditsReleasedRejected:
        case ROUTING.creditsRefundedRejected:
            // Credit could not pay out / refund. Needs a human: nothing here can fix it.
            log.error(`Credit refused ${routingKey} for errand ${errandId}: ${(payload as CreditsRejectionEvent).reason}`);
            break;
        default:
            log.warn(`Unhandled routing key: ${routingKey}`);
    }
};

export type { CreditsHeldEvent };