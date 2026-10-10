import log from "../../log.ts";
import type { IQueueProvider } from "../provider.ts";
import type amqp from "amqplib";

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
            this.dispatch(msg);
        });
    }

    /** handle routing of all messages received under queueName */
    private async dispatch(msg: amqp.ConsumeMessage | null): Promise<void> {
        if (!msg)
            return;

        const { routingKey } = msg.fields;
        const { correlationId, replyTo } = msg.properties;
        if (!correlationId || !replyTo) {
            log.warn(`RpcServer: malformed msg (topic: ${routingKey}), expected correlationId and replyTo to be set: ${msg.content.toString()}`);
            this.queue.nack(msg, false, false);
            return;
        }

        const handler = this.handlers.get(routingKey);
        if (!handler) {
            log.warn(`RpcServer: no handler for ${routingKey}`);
            this.queue.nack(msg, false, false);
            return;
        }

        let payload: unknown;
        try {
            payload = JSON.parse(msg.content.toString());
        } catch {
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
                await this.queue.replyToRpcCaller(replyTo, correlationId, {
                    ok: false,
                    error: e.code,
                });
                this.queue.ack(msg);
                return;
            }
            log.error(`RpcServer [${routingKey}]: ${e instanceof Error ? e.stack : e}`);

            try {
                await this.queue.replyToRpcCaller(replyTo, correlationId, { ok: false, error: "INTERNAL_ERROR" });
            } finally {
                this.queue.nack(msg, false, false);
            }
        }
    }
}


