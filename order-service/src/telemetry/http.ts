import { durationOptions, meter } from "./instruments.ts";

export const httpDuration = meter.createHistogram("campusgo.http.server.request.duration", durationOptions);
export const httpActive = meter.createUpDownCounter("campusgo.http.server.active_requests", { unit: "1" });
