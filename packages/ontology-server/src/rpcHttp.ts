import { Effect, Layer } from "effect";
import { HttpEffect } from "effect/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import {
    makeOntologyProtocolClient,
    ontologyRpcHandlers,
    OntologyRpcs,
    makeOntologyRpcClient,
} from "./rpc.js";
import type { OntologyRpcServerOptions, OntologyConnection } from "./rpc.js";
import type { BackendError } from "@party-stack/ontology-backend";
import type { Scope } from "effect";
import type { HttpClient } from "effect/http";

/** Mount the returned Fetch handler at a dedicated route. Its enclosing scope owns
 * the server and active streams; each request still passes mandatory authorization.
 */
export const makeOntologyHttpHandler = Effect.fn("RemoteOntology.httpHandler")(function* <R>(
    options: OntologyRpcServerOptions<R>
): Effect.fn.Return<(request: Request) => Promise<Response>, never, R | Scope.Scope> {
    const app = yield* RpcServer.toHttpEffect(OntologyRpcs).pipe(
        Effect.provide(ontologyRpcHandlers(options)),
        Effect.provide(RpcSerialization.layerNdjson)
    );
    return HttpEffect.toWebHandler(app);
});

/** Supply an Effect HttpClient with the desired authentication and fetch policy.
 * NDJSON keeps demand and invalidation subscriptions streaming until cancellation.
 */
export const connectOntologyHttp = Effect.fn("RemoteOntology.connectHttp")(function* (options: {
    readonly url: string;
    readonly retryIntervalMs?: number;
}): Effect.fn.Return<OntologyConnection, BackendError, HttpClient.HttpClient | Scope.Scope> {
    const client = yield* makeOntologyRpcClient.pipe(
        Effect.provide(
            RpcClient.layerProtocolHttp({ url: options.url }).pipe(
                Layer.provide(RpcSerialization.layerNdjson)
            )
        )
    );
    return yield* makeOntologyProtocolClient(client, options);
});
