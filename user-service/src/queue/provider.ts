import amqp from "amqplib";
import config from "../config.ts";
import { TransientReplyQueue } from "./transientReplyQueue.ts";

const DEFAULT_RPC_TIMEOUT = 60 * 1000;
const MAX_RPC_PENDING = 10000;

export interface IQueueProvider {
    publishEvent(routingKey: string, payload: EventPayload): Promise<void>;
    
    createReplyQueue(opts?: { defaultTimeoutMs?: number, maxPending?: number }): Promise<TransientReplyQueue>;
    replyToRpcCaller(replyTo: string, correlationId: string, payload: Record<string, unknown>): Promise<void>;

    // proxy methods
    consume(...args: Parameters<amqp.ConfirmChannel["consume"]>): ReturnType<amqp.ConfirmChannel["consume"]>;
    ack(...args: Parameters<amqp.ConfirmChannel["ack"]>): ReturnType<amqp.ConfirmChannel["ack"]>;
    nack(...args: Parameters<amqp.ConfirmChannel["nack"]>): ReturnType<amqp.ConfirmChannel["nack"]>;
}

export type EventPayload = Record<string, any> & AuxPayloadInfo;
interface AuxPayloadInfo {
    eventId?: string,
    type: string,
}

export class RabbitMqProvider implements IQueueProvider {
    connection: amqp.ChannelModel;
    ch: amqp.ConfirmChannel;

    private constructor(connection: amqp.ChannelModel, ch: amqp.ConfirmChannel) {
        this.connection = connection;
        this.ch = ch;
    }

    static async connect(url: string) {
        const connection = await amqp.connect(url);
        const ch = await connection.createConfirmChannel();
        const provider = new RabbitMqProvider(connection, ch);
        await provider.setup();
        return provider;
    }

    private async setup() {
        // main router: publishes to interested services (which are their own queues)
        await this.ch.assertExchange("app.events", "topic", { durable: true });
        await this.ch.assertExchange("app.rpc", "direct", { durable: true });
        await this.ch.assertExchange("app.dlx", "topic", { durable: true });

        // example of use in another 
        // await this.ch.assertQueue("credit.user-registered", {
        //     durable: true,
        //     // deadLetterExchange: "app.dlx",
        //     // deadLetterRoutingKey: "credit.user-registered.dlq",
        // });
        // await this.ch.bindQueue("credit.user-registered", "app.events", "user.registered");

        await this.ch.assertQueue("user.rpc", { durable: true });
        await this.ch.bindQueue("user.rpc", "app.rpc", "user.query");
    }

    async createReplyQueue({ defaultTimeoutMs = DEFAULT_RPC_TIMEOUT, maxPending = MAX_RPC_PENDING }: { defaultTimeoutMs?: number, maxPending?: number } = {}): Promise<TransientReplyQueue> {
        const { queue } = await this.ch.assertQueue("", { exclusive: true });
        const rq = new TransientReplyQueue(this.ch, queue, defaultTimeoutMs, maxPending);
        await rq.start();
        return rq;
    }


    async replyToRpcCaller(replyTo: string, correlationId: string, payload: Record<string, unknown>): Promise<void> {
        const encodedPayload = Buffer.from(JSON.stringify(payload));
        await new Promise<void>((res, rej) => {
            this.ch.sendToQueue(replyTo, encodedPayload, {
                contentType: "application/json",
                correlationId,
                timestamp: Date.now(),
            }, err => (err ? rej(err) : res()));
        });
    }


    async publishEvent(routingKey: string, payload: EventPayload) {
        const encodedPayload = Buffer.from(JSON.stringify(payload));
        await new Promise<void>((res, rej) => {
            this.ch.publish("app.events", routingKey, encodedPayload, {
                persistent: true,
                contentType: "application/json",
                messageId: payload.eventId ?? crypto.randomUUID(),
                timestamp: Date.now(),
                type: payload.type,
            }, err => {
                if (err)
                    rej(err);
                res();
            });
        });
    }

    consume(...args: Parameters<amqp.Channel["consume"]>): ReturnType<amqp.Channel["consume"]> {
        return this.ch.consume(...args);
    }

    ack(...args: Parameters<amqp.Channel["ack"]>): ReturnType<amqp.Channel["ack"]> {
        return this.ch.ack(...args);
    }
    
    nack(...args: Parameters<amqp.Channel["nack"]>): ReturnType<amqp.Channel["nack"]> {
        return this.ch.nack(...args);
    }
}

export const buildDefaultProvider = async () => {
    if (!config.rabbitMqConnectionString) {
        throw new Error("rabbitmq connection string not found in config");
    }
    const provider = await RabbitMqProvider.connect(config.rabbitMqConnectionString!);
    return provider;
}
