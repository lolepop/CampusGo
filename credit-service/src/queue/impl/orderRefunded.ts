import log from "../../log.ts";
import { SpanKind } from "@opentelemetry/api";
import { withMessagingSpan } from "../../telemetry/messaging.ts";
import { extractTraceContext } from "../../telemetry/propagation.ts";
import { recordError } from "../../telemetry/tracing.ts";
import type amqp from "amqplib";
import { ensureCreditsRefunded } from "../../services/credits.ts";
import { isNonEmptyString } from "../../util/isNonEmptyString.ts";

export async function consumeOrderRefunded(ch: amqp.ConfirmChannel): Promise<void> {
    let closed = false;
    ch.once("close", () => { closed = true; });

    await ch.consume("credit.order-refunded", async msg => {
        if (msg === null || closed) return;

        await withMessagingSpan("process", "credit.order-refunded", SpanKind.CONSUMER, async () => {

            try {
                let payload: { errandId: string };
                try {
                    const parsed = JSON.parse(msg.content.toString()) as {
                        errandId?: unknown;
                    } | null;
                    if (!isNonEmptyString(parsed?.errandId)) {
                        throw new Error("credit.order-refunded must contain valid errandId");
                    }
                    payload = { errandId: parsed.errandId };
                } catch (error) {
                    recordError(error);
                    log.error("Invalid credit.order-refunded event", error);
                    // Invalid messages cannot succeed on retry.
                    if (!closed) ch.nack(msg, false, false);
                    return;
                }

                try {
                    await ensureCreditsRefunded(payload.errandId);
                } catch (error) {
                    recordError(error);
                    log.error("Failed to process credit.order-refunded event", error);
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
                log.error("Failed to settle credit.order-refunded event", error);
            }
        }, extractTraceContext(msg.properties.headers));
    }, { noAck: false });
}