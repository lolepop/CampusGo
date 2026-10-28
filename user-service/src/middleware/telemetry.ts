// AI assistance (26/9/2026): codex
// hooks and proxies genarated as per my design requirements on hooking

import type { Application, Middleware, RouterContext } from "@oak/oak";
import { context, createContextKey, SpanKind, trace } from "@opentelemetry/api";
import { extractTraceContext } from "../telemetry/propagation.ts";
import { httpActive, httpDuration } from "../telemetry/http.ts";
import { markSpanError, recordError, traceLogFields, withSpan } from "../telemetry/tracing.ts";
import { recordAuthResponse } from "../telemetry/user.ts";

interface RequestTelemetry {
    route: string;
}

const requestTelemetryKey = createContextKey("campusgo.http.request");
const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE"]);

/** Install before routes: retain the matched template and record throws before Oak makes a response. */
export const httpTelemetryMiddleware: Middleware = async (ctx, next) => {
    try {
        await next();
    } catch (error) {
        const status = (error as { status?: number })?.status ?? 500;
        if (status >= 500)
            recordError(error);
        throw error; // let Oak preserve its existing error-response behavior
    } finally {
        const state = context.active().getValue(requestTelemetryKey) as RequestTelemetry | undefined;
        const matched = (ctx as RouterContext<string>).matched?.filter(layer => layer.methods.length > 0);
        const route = matched?.findLast(layer => layer.methods.includes(ctx.request.method)) ?? matched?.at(-1);
        if (state && route && typeof route.path === "string")
            state.route = route.path;
    }
};

/**
 * Pass directly to Deno.serve to retain its native context. Adds X-Trace-Id and bounded HTTP metrics.
 * Duration/active requests end when Oak produces a response, excluding streamed-body transmission.
 * Direct callers without a native span receive a W3C-extracted fallback server span.
 */
export function createHttpHandler(app: Application) {
    return (request: Request, info?: Pick<Deno.ServeHandlerInfo, "remoteAddr">): Promise<Response> => {
        const method = methods.has(request.method) ? request.method : "_OTHER";
        const handle = async (): Promise<Response> => {
            const state: RequestTelemetry = { route: "UNMATCHED" };
            return await context.with(context.active().setValue(requestTelemetryKey, state), async () => {
                const span = trace.getActiveSpan();
                const start = performance.now();
                httpActive.add(1);
                let response: Response;
                try {
                    const remoteAddr = info?.remoteAddr;
                    const result = await app.handle(request, remoteAddr && "hostname" in remoteAddr ? remoteAddr : undefined);
                    if (!result)
                        throw new Error("Oak did not produce an HTTP response");
                    response = result;
                } catch (error) {
                    recordError(error, span);
                    response = new Response(JSON.stringify({ error: "unknown error" }), {
                        status: 500,
                        headers: { "Content-Type": "application/json" },
                    });
                } finally {
                    httpActive.add(-1);
                }
                span?.updateName(`${method} ${state.route}`);
                span?.setAttributes({ "http.route": state.route, "http.response.status_code": response.status });
                if (response.status >= 500)
                    markSpanError(span);
                const traceId = traceLogFields().trace_id;
                if (traceId)
                    response.headers.set("X-Trace-Id", traceId);
                httpDuration.record((performance.now() - start) / 1000, {
                    "http.route": state.route,
                    "http.request.method": method,
                    "http.response.status_code": response.status,
                });
                recordAuthResponse(method, state.route, response.status);
                return response;
            });
        };
        if (trace.getActiveSpan())
            return handle();
        // Also supports app.handle callers and isolated tests without a native server span.
        return withSpan(method, { kind: SpanKind.SERVER }, handle, extractTraceContext(Object.fromEntries(request.headers)));
    };
}
