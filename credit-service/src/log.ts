import { traceLogFields } from "./telemetry/tracing.ts";

const describe = (value: unknown): string => {
    if (value instanceof Error) return value.stack ?? value.message;
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value, (_key, field) => typeof field === "bigint" ? String(field) : field) ?? String(value);
    } catch {
        return Deno.inspect(value);
    }
};

const write = (level: "debug" | "info" | "warn" | "error", args: unknown[]) => {
    const fields = traceLogFields();
    if (Deno.env.get("NODE_ENV") === "production") {
        console[level](JSON.stringify({ timestamp: new Date().toISOString(), level, ...fields,
            message: args.map(describe).join(" ") }));
    } else {
        console[level](...(fields.trace_id ? [`[trace=${fields.trace_id} span=${fields.span_id}]`] : []), ...args);
    }
};

/** Preserve console-style arguments while adding active span IDs; never create a span for logging. */
export default {
    debug: (...args: unknown[]) => write("debug", args),
    info: (...args: unknown[]) => write("info", args),
    warn: (...args: unknown[]) => write("warn", args),
    error: (...args: unknown[]) => write("error", args),
};
