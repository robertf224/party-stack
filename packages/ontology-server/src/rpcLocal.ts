import { Effect } from "effect";
import { RpcGroup, RpcServer } from "effect/rpc";
import { ontologyServerDispatch, selectOntology } from "./routing.js";
import {
    makeTracedRpcClientNoSerialization,
    makeTrustedOntologyProtocolClient,
    OntologyRpcs,
} from "./rpc.js";
import type { OntologyServer } from "./routing.js";
import type { OntologyServerClient, OntologyClientOptions } from "./rpc.js";
import type { Scope } from "effect";

/** Connect to a borrowed server in the same JavaScript runtime. The connection
 * owns its RPC requests and subscriptions; closing it never closes the server.
 * Local routes use their trusted context binding, like worker routes.
 */
export const makeOntologyLocalClient = Effect.fn("OntologyClient.local")(function* <R>(
    server: OntologyServer<R>,
    options?: { readonly ontology?: string }
): Effect.fn.Return<OntologyServerClient, never, R | Scope.Scope> {
    type Rpcs = RpcGroup.Rpcs<typeof OntologyRpcs>;
    let client!: Effect.Success<ReturnType<typeof makeTracedRpcClientNoSerialization<Rpcs, never>>>;
    const dispatch = yield* RpcServer.makeNoSerialization(OntologyRpcs, {
        onFromServer: (response) => client.write(response),
    }).pipe(Effect.provide(ontologyServerDispatch(server)));
    client = yield* makeTracedRpcClientNoSerialization(OntologyRpcs, {
        supportsAck: true,
        onFromClient: ({ message }) => dispatch.write(0, message),
    });
    const rpc = client.client;
    return {
        ontology: Effect.fn("OntologyClient.select")(function* (
            selected?: string,
            clientOptions?: OntologyClientOptions
        ) {
            const name = selected ?? options?.ontology;
            return yield* makeTrustedOntologyProtocolClient(
                name === undefined ? rpc : selectOntology(rpc, name),
                clientOptions
            );
        }),
    };
});
