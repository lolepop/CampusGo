import { metrics } from "@opentelemetry/api";

export const meter = metrics.getMeter("campusgo.user-service");
export const durationOptions = {
    unit: "s",
    advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] },
};
export const queueDurationOptions = {
    unit: "s",
    advice: { explicitBucketBoundaries: [...durationOptions.advice.explicitBucketBoundaries, 300, 1800, 3600] },
};
