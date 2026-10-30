import log from "../../log.ts";
import type { IQueueProvider } from "../provider.ts";
import type amqp from "amqplib";
import { extractTraceContext } from "../../telemetry/propagation.ts";
import { markSpanError, recordError } from "../../telemetry/tracing.ts";
import { SpanKind } from "@opentelemetry/api";
import { withMessagingSpan } from "../../telemetry/messaging.ts";

/** throw from handler to send failure code back to caller */
export class RpcBadRequest extends Error {
    constructor(public readonly code: string, message?: string) {
        super(message ?? code);
        this.name = "RpcBadRequest";
    }
}

export type RpcHandler = (payload: any) => Promise<unknown>;

/** routes topics in a queue to registered handlers */
export class RpcRouter {
    private readonly queue: IQueueProvider;
    private readonly handlers = new Map<string, RpcHandler>();
    private queueName: string;

    constructor(queueName: string, queue: IQueueProvider) {
        this.queueName = queueName;
        this.queue = queue;
    }

    /** subscribe to all messages within the topic. throw RpcBadRequest to indicate failure response */
    register(routingKey: string, handler: RpcHandler) {
        this.handlers.set(routingKey, handler);
    }

    async start() {
        await this.queue.consume(this.queueName, msg => {
            this.dispatch(msg).catch(() => { /* already recorded and logged */ });
        });
    }

    private async dispatch(msg: amqp.ConsumeMessage | null): Promise<void> {
        if (!msg)
            return;

        await withMessagingSpan("rpc.process", this.queueName, SpanKind.CONSUMER, async span => {
            span.setAttribute("messaging.rabbitmq.destination.routing_key", msg.fields.routingKey);
            if (msg.properties.correlationId)
                span.setAttribute("messaging.message.conversation_id", msg.properties.correlationId);
            try {
                await this.dispatchMessage(msg);
            } catch (e) {
                log.error(`RpcRouter dispatch failed: ${e instanceof Error ? e.stack : e}`);
                throw e;
            }
        }, extractTraceContext(msg.properties.headers));
    }

    /** handle routing of all messages received under queueName */
    private async dispatchMessage(msg: amqp.ConsumeMessage): Promise<void> {
        const { routingKey } = msg.fields;
        const { correlationId, replyTo } = msg.properties;
        if (!correlationId || !replyTo) {
            markSpanError();
            log.warn(`RpcServer: malformed msg (topic: ${routingKey}), expected correlationId and replyTo to be set: ${msg.content.toString()}`);
            this.queue.nack(msg, false, false);
            return;
        }

        const handler = this.handlers.get(routingKey);
        if (!handler) {
            markSpanError();
            log.warn(`RpcServer: no handler for ${routingKey}`);
            this.queue.nack(msg, false, false);
            return;
        }

        let payload: unknown;
        try {
            payload = JSON.parse(msg.content.toString());
        } catch (e) {
            recordError(e);
            log.warn(`RpcServer: malformed JSON on ${routingKey}`);
            this.queue.nack(msg, false, false);
            return;
        }

        try {
            const result = await handler(payload);
            await this.queue.replyToRpcCaller(replyTo, correlationId, {
                ok: true,
                result,
            });
            this.queue.ack(msg);
        } catch (e) {
            if (e instanceof RpcBadRequest) {
                if (e.code === "DB_ERROR" || e.code === "INTERNAL_ERROR")
                    recordError(e);
                await this.queue.replyToRpcCaller(replyTo, correlationId, {
                    ok: false,
                    error: e.code,
                });
                this.queue.ack(msg);
                return;
            }
            recordError(e);
            log.error(`RpcServer [${routingKey}]: ${e instanceof Error ? e.stack : e}`);

            try {
                await this.queue.replyToRpcCaller(replyTo, correlationId, { ok: false, error: "INTERNAL_ERROR" });
            } finally {
                this.queue.nack(msg, false, false);
            }
        }
    }
}


