import { unauthenticated } from "@party-stack/ontology-backend";
import type { ConnectionEgressHandlers } from "./types.js";

export function withHttpAuthenticationErrorHandling(
    handlers: ConnectionEgressHandlers
): ConnectionEgressHandlers {
    return {
        ...handlers,
        async fetch(request) {
            const response = await handlers.fetch(request);
            if (response.status === 401) {
                throw unauthenticated("Request failed with status 401.");
            }
            return response;
        },
    };
}
