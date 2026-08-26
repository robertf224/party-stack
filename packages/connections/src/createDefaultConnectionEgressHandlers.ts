import type { ConnectionEgressHandlers } from "./types.js";

export function createDefaultConnectionEgressHandlers(): ConnectionEgressHandlers {
    const fetchImpl = globalThis.fetch.bind(globalThis);
    return {
        fetch: (request) => fetchImpl(request),
        createWebSocket: (url, protocols) =>
            Promise.resolve(
                new WebSocket(url, protocols)
            ),
    };
}
