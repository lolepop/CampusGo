import { meter } from "./instruments.ts";

/** Start one process heartbeat independent of broker/database polling; dispose it on unload. */
export function startHeartbeat(): () => void {
    const heartbeat = meter.createObservableGauge("campusgo.telemetry.heartbeat", { unit: "s" });
    const observe = (result: { observe: (value: number) => void }) => result.observe(Date.now() / 1000);
    heartbeat.addCallback(observe);
    return () => heartbeat.removeCallback(observe);
}
