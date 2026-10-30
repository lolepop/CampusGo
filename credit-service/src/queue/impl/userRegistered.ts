import log from "../../log.ts";
import { SpanKind } from "@opentelemetry/api";
import { withMessagingSpan } from "../../telemetry/messaging.ts";
import { extractTraceContext } from "../../telemetry/propagation.ts";
import { recordError } from "../../telemetry/tracing.ts";
import type amqp from "amqplib";
import { ensureCreditAccount } from "../../services/credits.ts";
import { isPositiveInt } from "../../util/isPositiveInt.ts";

export async function consumeUserRegistered(ch: amqp.ConfirmChannel): Promise<void> {
    let closed = false;
    ch.once("close", () => { closed = true; });

    await ch.consume("credit.user-registered", async msg => {
        if (msg === null || closed) return;

        await withMessagingSpan("process", "credit.user-registered", SpanKind.CONSUMER, async () => {

            try {
                let payload: { userId: number };
                try {
                    const parsed = JSON.parse(msg.content.toString()) as {
                        userId?: unknown;
                    } | null;
                    if (!isPositiveInt(parsed?.userId)) {
                        throw new Error("credit.user-registered must contain valid userId");
                    }
                    payload = { userId: parsed.userId };
                } catch (error) {
                    recordError(error);
                    log.error("Invalid credit.user-registered event", error);
                    // Invalid messages cannot succeed on retry.
                    if (!closed) ch.nack(msg, false, false);
                    return;
                }

                try {
                    await ensureCreditAccount(payload.userId);
                } catch (error) {
                    recordError(error);
                    log.error("Failed to process credit.user-registered event", error);
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
                log.error("Failed to settle credit.user-registered event", error);
            }
        }, extractTraceContext(msg.properties.headers));
    }, { noAck: false });
}
