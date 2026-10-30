import { meter, queueDurationOptions } from "./instruments.ts";

export const outboxAttempts = meter.createCounter("campusgo.outbox.publish.attempts", { unit: "1" });
export const outboxConfirmationDelay = meter.createHistogram("campusgo.outbox.confirmation.delay", queueDurationOptions);
export const outboxBatchFailures = meter.createCounter("campusgo.outbox.batch.failures", { unit: "1" });
export const outboxWorkerRunning = meter.createGauge("campusgo.outbox.worker.running");
export const outboxLastPoll = meter.createGauge("campusgo.outbox.worker.last_success", { unit: "s" });
export const rabbitAvailable = meter.createGauge("campusgo.rabbitmq.connection.available");
export const rabbitTransitions = meter.createCounter("campusgo.rabbitmq.connection.transitions", { unit: "1" });
