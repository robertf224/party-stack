import { unauthenticated } from "@party-stack/ontology-backend";
import { Effect } from "effect";
import type { ConnectionEgressHandlers } from "./types.js";

export function withHttpAuthenticationErrors(handlers: ConnectionEgressHandlers): ConnectionEgressHandlers {
    return {
        ...handlers,
        fetch: Effect.fnUntraced(function* (request: Request) {
            const response = yield* handlers.fetch(request);
            if (response.status === 401) {
                if (response.body)
                    yield* Effect.promise(() => response.body!.cancel()).pipe(Effect.ignoreCause);
                return yield* unauthenticated("Request failed with status 401.");
            }
            return response;
        }),
    };
}
