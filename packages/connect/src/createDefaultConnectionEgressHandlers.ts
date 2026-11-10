import type { ConnectionEgressHandlers } from "./types.js";

export function createDefaultConnectionEgressHandlers(): ConnectionEgressHandlers {
    const fetchImpl = globalThis.fetch.bind(globalThis);
    return {
        fetch: (request) =>
            Effect.tryPromise({
                try: (signal) =>
                    fetchImpl(
                        new Request(request, {
                            signal: AbortSignal.any([request.signal, signal]),
                        })
                    ),
                catch: (cause) => classifyBackendFailure("connect.egress.fetch", cause),
            }),
        createWebSocket: (url, protocols) =>
            Effect.try({
                try: () => new WebSocket(url, protocols),
                catch: (cause) => classifyBackendFailure("connect.egress.webSocket", cause),
            }),
    };
}
import { classifyBackendFailure } from "@party-stack/ontology-backend";
import { Effect } from "effect";
