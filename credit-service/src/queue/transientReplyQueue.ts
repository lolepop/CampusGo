import amqp from "amqplib";
import { context, SpanKind, trace, type Context, type Span } from "@opentelemetry/api";
import { captureTraceContext, extractTraceContext } from "../telemetry/propagation.ts";
import { recordError } from "../telemetry/tracing.ts";
import { withMessagingSpan } from "../telemetry/messaging.ts";
import { rpcOutcomes, rpcPending, type RpcOutcome } from "../telemetry/queue.ts";

interface PendingRpc {
    setOutcome: (outcome: RpcOutcome) => void;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timer: NodeJS.Timeout;
    createdAt: number;
    routingKey: string;
    context: Context;
    span: Span;
}

export class RpcTimeoutError extends Error {
    constructor(public routingKey: string, public timeoutMs: number) {
        super(`RPC to "${routingKey}" timed out after ${timeoutMs}ms`);
        this.name = "RpcTimeoutError";
    }
}

export class RpcDisconnectedError extends Error {
    constructor(public queueName: string) {
        super(`TransientReplyQueue "${queueName}" lost connection to queue`);
        this.name = "RpcDisconnectedError";
    }
}

export class TransientReplyQueue {
    private ch: amqp.ConfirmChannel;
    private name: string = "";
    
    private pendingTasks = new Map<string, PendingRpc>();
    private defaultTimeoutMs: number;
    private maxPending: number;

    private state: "uninit" | "open" | "suspended" | "closing" | "closed" = "uninit";
    private consumerTag: string | null = null;
    private closerTask: Promise<void> | null = null;
    private readonly onClosedListeners = new Set<() => void>();

    constructor(ch: amqp.ConfirmChannel, defaultTimeoutMs: number, maxPending: number) {
        this.ch = ch;
        this.defaultTimeoutMs = defaultTimeoutMs;
        this.maxPending = maxPending;
    }

    /** creates reply queue and start consuming replies. */
    async start(): Promise<void> {
        const { queue } = await this.ch.assertQueue("", { exclusive: true });
        this.name = queue;
        const { consumerTag } = await this.ch.consume(this.name, msg => {
            this.replyCb(msg).catch(() => { /* failure is recorded on the receive span */ });
        }, { noAck: false });
        this.consumerTag = consumerTag;
        this.state = "open";
    }

    /** trigger listener when queue was manually closed */
    onClosed(listener: () => void): () => void {
        this.onClosedListeners.add(listener);
        return () => { this.onClosedListeners.delete(listener); };
    }

    /** connection to queue lost. reject pending rpcs and wait for handleReconnect */
    handleDisconnect(): void {
        if (this.state === "closed" || this.state === "closing")
            return;
        this.state = "suspended";
        this.consumerTag = null;
        const err = new RpcDisconnectedError(this.name);
        for (const [_, task] of this.pendingTasks) {
            clearTimeout(task.timer);
            task.setOutcome("disconnect");
            task.reject(err);
        }
        this.pendingTasks.clear();
    }

    /** if the parent connection died and reconnects, rebuild the queue automatically */
    async handleReconnect(ch: amqp.ConfirmChannel): Promise<void> {
        if (this.state === "closed" || this.state === "closing")
            return;
        this.ch = ch;
        await this.start();
    }

    /**
     * Trace one request/reply round trip. Keep correlationId for matching and save caller context.
     * Record exactly one bounded terminal outcome; pending counts only calls admitted to the map.
     */
    async call(routingKey: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
        let outcome: RpcOutcome = "publication_failure";
        let admitted = false;
        try {
            return await withMessagingSpan("rpc.call", "app.rpc", SpanKind.CLIENT, async span => {
                if (this.state !== "open") {
                    outcome = "unavailable";
                    throw new Error(`TransientReplyQueue "${this.name}" is ${this.state}`);
                }
                if (this.pendingTasks.size >= this.maxPending) {
                    outcome = "capacity";
                    throw new Error(`TransientReplyQueue "${this.name}" at capacity (${this.maxPending})`);
                }

                const correlationId = crypto.randomUUID();
                const timeout = timeoutMs ?? this.defaultTimeoutMs;
                span.setAttributes({ "messaging.message.conversation_id": correlationId, "messaging.rabbitmq.destination.routing_key": routingKey });
                const encodedPayload = Buffer.from(JSON.stringify(payload));
                return await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                        // auto remove entry
                        if (!this.pendingTasks.delete(correlationId))
                            return;
                        outcome = "timeout";
                        reject(new RpcTimeoutError(routingKey, timeout));
                    }, timeout);

                    this.pendingTasks.set(correlationId, {
                        setOutcome: value => { outcome = value; },
                        resolve, reject, timer, createdAt: Date.now(), routingKey,
                        context: context.active(), span,
                    });
                    admitted = true;
                    rpcPending.add(1);

                    const failPublication = (error: unknown) => {
                        const entry = this.pendingTasks.get(correlationId);
                        if (entry) {
                            this.pendingTasks.delete(correlationId);
                            clearTimeout(entry.timer);
                            entry.setOutcome("publication_failure");
                            entry.reject(error);
                        }
                    };
                    // define no dlq on rpc consumer queues, expired items are deleted automatically.
                    // we let the items naturally timeout in the managed mapping
                    // prevents rpc worker from doing expired work which would be immediately discarded on return
                    try {
                        this.ch.publish("app.rpc", routingKey, encodedPayload, {
                            persistent: true,
                            contentType: "application/json",
                            correlationId,
                            replyTo: this.name,
                            timestamp: Date.now(),
                            expiration: "" + timeout,
                            headers: captureTraceContext(),
                        }, err => {
                            if (err)
                                failPublication(err);
                        });
                    } catch (error) {
                        failPublication(error);
                    }
                });
            });
        } finally {
            if (admitted)
                rpcPending.add(-1);
            rpcOutcomes.add(1, { outcome });
        }
    }

    /** Match a reply by correlationId, restore the saved caller, and trace processing under remote context when valid. */
    private async replyCb(msg: amqp.ConsumeMessage | null): Promise<void> {
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
        const remote = extractTraceContext(msg.properties.headers);
        const parent = trace.getSpanContext(remote) ? remote : entry.context;
        await context.with(entry.context, () => withMessagingSpan("rpc.receive", "rpc.reply", SpanKind.CONSUMER, async span => {
            span.setAttribute("messaging.message.conversation_id", correlationId!);
            try {
                const payload = JSON.parse(msg.content.toString());
                entry.setOutcome(payload?.ok === true ? "success" : payload?.ok === false ? "rejected" : "malformed_reply");
                if (typeof payload?.ok !== "boolean") {
                    const error = new Error("Malformed RPC reply envelope");
                    recordError(error, span);
                    recordError(error, entry.span);
                }
                if (payload?.ok === false && (payload.error === "DB_ERROR" || payload.error === "INTERNAL_ERROR")) {
                    entry.setOutcome("remote_error");
                    const error = new Error(`RPC failed: ${payload.error}`);
                    recordError(error, span);
                    recordError(error, entry.span);
                }
                entry.resolve(payload);
            } catch (e) {
                entry.setOutcome("malformed_reply");
                recordError(e, span);
                entry.reject(e);
            }
            this.ch.ack(msg);
        }, parent));
    }

    close() {
        if (this.closerTask)
            return this.closerTask;

        this.state = "closing";
        this.closerTask = (async () => {
            for (const [_, entry] of this.pendingTasks) {
                clearTimeout(entry.timer);
                entry.setOutcome("closure");
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
            for (const emit of this.onClosedListeners) {
                emit();
            }
        })();

        return this.closerTask;
    }
}
