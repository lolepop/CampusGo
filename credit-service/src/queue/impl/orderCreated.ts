import log from "../../log.ts";
import { SpanKind } from "@opentelemetry/api";
import { withMessagingSpan } from "../../telemetry/messaging.ts";
import { extractTraceContext } from "../../telemetry/propagation.ts";
import { recordError } from "../../telemetry/tracing.ts";
import type amqp from "amqplib";
import { ensureCreditsHeld } from "../../services/credits.ts";
import { isPositiveInt } from "../../util/isPositiveInt.ts";
import { isNonEmptyString } from "../../util/isNonEmptyString.ts";

export async function consumeOrderCreated(ch: amqp.ConfirmChannel): Promise<void> {
    let closed = false;
    ch.once("close", () => { closed = true; });

    await ch.consume("credit.order-created", async msg => {
        if (msg === null || closed) return;

        await withMessagingSpan("process", "credit.order-created", SpanKind.CONSUMER, async () => {

            try {
                let payload: { errandId: string; requestorId: number; amount: number };
                try {
                    const parsed = JSON.parse(msg.content.toString()) as {
                        errandId?: unknown;
                        requestorId?: unknown;
                        amount?: unknown;
                    } | null;
                    if (!isNonEmptyString(parsed?.errandId)
                        || !isPositiveInt(parsed?.requestorId)
                        || !isPositiveInt(parsed?.amount)) {
                        throw new Error("credit.order-created must contain valid errandId, requestorId, amount");
                    }
                    payload = { errandId: parsed.errandId, requestorId: parsed.requestorId, amount: parsed.amount };
                } catch (error) {
                    recordError(error);
                    log.error("Invalid credit.order-created event", error);
                    // Invalid messages cannot succeed on retry.
                    if (!closed) ch.nack(msg, false, false);
                    return;
                }

                try {
                    await ensureCreditsHeld(payload.errandId, payload.requestorId, payload.amount);
                } catch (error) {
                    recordError(error);
                    log.error("Failed to process credit.order-created event", error);
                    // Back off before retrying dependency failures.
                    if (!closed) {
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                    if (!closed) ch.nack(msg, false, true);
                    return;
                }

                // Business rejections are handled by the service's committed outbox events.
                if (!closed) ch.ack(msg);
            } catch (error) {
                recordError(error);
                // If the channel closes during settlement, RabbitMQ requeues the delivery.
                log.error("Failed to settle credit.order-created event", error);
            }
        }, extractTraceContext(msg.properties.headers));
    }, { noAck: false });
}