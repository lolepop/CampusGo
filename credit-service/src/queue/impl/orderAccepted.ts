import log from "../../log.ts";
import { SpanKind } from "@opentelemetry/api";
import { withMessagingSpan } from "../../telemetry/messaging.ts";
import { extractTraceContext } from "../../telemetry/propagation.ts";
import { recordError } from "../../telemetry/tracing.ts";
import type amqp from "amqplib";
import { ensureCreditsAccepted } from "../../services/credits.ts";
import { isNonEmptyString } from "../../util/isNonEmptyString.ts";
import { isPositiveInt } from "../../util/isPositiveInt.ts";

export async function consumeOrderAccepted(ch: amqp.ConfirmChannel): Promise<void> {
    let closed = false;
    ch.once("close", () => { closed = true; });

    await ch.consume("credit.order-accepted", async msg => {
        if (msg === null || closed) return;

        await withMessagingSpan("process", "credit.order-accepted", SpanKind.CONSUMER, async () => {

            try {
                let payload: { errandId: string; courierId: number };
                try {
                    const parsed = JSON.parse(msg.content.toString()) as {
                        errandId?: unknown;
                        courierId?: unknown;
                    } | null;
                    if (!isNonEmptyString(parsed?.errandId)
                        || !isPositiveInt(parsed?.courierId)) {
                        throw new Error("credit.order-accepted must contain valid errandId, courierId");
                    }
                    payload = { errandId: parsed.errandId, courierId: parsed.courierId };
                } catch (error) {
                    recordError(error);
                    log.error("Invalid credit.order-accepted event", error);
                    // Invalid messages cannot succeed on retry.
                    if (!closed) ch.nack(msg, false, false);
                    return;
                }

                try {
                    await ensureCreditsAccepted(payload.errandId, payload.courierId);
                } catch (error) {
                    recordError(error);
                    log.error("Failed to process credit.order-accepted event", error);
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
                log.error("Failed to settle credit.order-accepted event", error);
            }
        }, extractTraceContext(msg.properties.headers));
    }, { noAck: false });
}