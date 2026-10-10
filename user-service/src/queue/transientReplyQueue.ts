import amqp from "amqplib";

interface PendingRpc {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timer: NodeJS.Timeout;
    createdAt: number;
    routingKey: string;
}

export class RpcTimeoutError extends Error {
    constructor(public routingKey: string, public timeoutMs: number) {
        super(`RPC to "${routingKey}" timed out after ${timeoutMs}ms`);
        this.name = "RpcTimeoutError";
    }
}

export class TransientReplyQueue {
    private ch: amqp.ConfirmChannel;
    private name: string
    
    private pendingTasks = new Map<string, PendingRpc>();
    private defaultTimeoutMs: number;
    private maxPending: number;

    private state: "uninit" | "open" | "closing" | "closed" = "uninit";
    private consumerTag: string | null = null;
    private closerTask: Promise<void> | null = null;

    constructor(ch: amqp.ConfirmChannel, name: string, defaultTimeoutMs: number, maxPending: number) {
        this.ch = ch;
        this.name = name;
        this.defaultTimeoutMs = defaultTimeoutMs;
        this.maxPending = maxPending;
    }

    async start(): Promise<void> {
        const { consumerTag } = await this.ch.consume(this.name, msg => this.replyCb(msg), { noAck: false });
        this.consumerTag = consumerTag;
        this.state = "open";
    }

    /** invokes rpc (point to point) call on consumer of routingKey */
    async call(routingKey: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
        if (this.state !== "open")
            throw new Error(`TransientReplyQueue "${this.name}" is ${this.state}`);
        if (this.pendingTasks.size >= this.maxPending)
            throw new Error(`TransientReplyQueue "${this.name}" at capacity (${this.maxPending})`);

        const correlationId = crypto.randomUUID();
        const timeout = timeoutMs ?? this.defaultTimeoutMs;

        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                // auto remove entry
                if (!this.pendingTasks.delete(correlationId))
                    return;
                reject(new RpcTimeoutError(routingKey, timeout));
            }, timeout);
            // timer.unref?.();

            this.pendingTasks.set(correlationId, {
                resolve, reject, timer, createdAt: Date.now(), routingKey,
            });

            const encodedPayload = Buffer.from(JSON.stringify(payload));
            // define no dlq on rpc consumer queues, expired items are deleted automatically.
            // we let the items naturally timeout in the managed mapping
            // prevents rpc worker from doing expired work which would be immediately discarded on return
            this.ch.publish("app.rpc", routingKey, encodedPayload, {
                persistent: true,
                contentType: "application/json",
                correlationId,
                replyTo: this.name,
                timestamp: Date.now(),
                expiration: "" + timeout,
            }, err => {
                if (!err)
                    return; // promise resolution already handled by replyCb, do nothing

                // in case of queue error (replyCb never invoked)
                const entry = this.pendingTasks.get(correlationId);
                if (entry) {
                    this.pendingTasks.delete(correlationId);
                    clearTimeout(entry.timer);
                    entry.reject(err);
                }
            });
        });
    }

    /** on reply from the caller, handle response */
    private replyCb(msg: amqp.ConsumeMessage | null) {
        if (!msg)
            return;

        const correlationId = msg.properties.correlationId;
        const entry = correlationId ? this.pendingTasks.get(correlationId) : undefined;
        if (!entry) {
            this.ch.ack(msg);
            return;
        }

        // safe to delete since caller awaits directly on call()
        this.pendingTasks.delete(correlationId!);
        clearTimeout(entry.timer);
        try {
            entry.resolve(JSON.parse(msg.content.toString()));
        } catch (e) {
            entry.reject(e);
        }
        this.ch.ack(msg);
    }

    close() {
        if (this.closerTask)
            return this.closerTask;

        this.state = "closing";
        this.closerTask = (async () => {
            for (const [_, entry] of this.pendingTasks) {
                clearTimeout(entry.timer);
                entry.reject(new Error(`TransientReplyQueue "${this.name}" closed`));
            }
            this.pendingTasks.clear();
            if (this.consumerTag) {
                try {
                    await this.ch.cancel(this.consumerTag);
                } catch (e) {
                    // channel was already down, do nothing
                }
            }
            this.state = "closed";
        })();

        return this.closerTask;
    }
}