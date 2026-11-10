import { Context, Effect, Layer } from "effect";
import { HttpEffect } from "effect/http";
import { makeOntologyHttpHandler } from "./rpcHttp.js";
import type { OntologyServer } from "./routing.js";

export { makeOntologyServer } from "./routing.js";
export { makeOntologyHttpHandler } from "./rpcHttp.js";
export type { OntologyAuthenticate, OntologyInternalAccess } from "./composition.js";

/** The enclosing Layer owns the backend, maintenance and transport resources. */
export class OntologyHttpServer extends Context.Service<
    OntologyHttpServer,
    {
        readonly handleRequest: (request: Request) => Promise<Response>;
    }
>()("@party-stack/ontology-server/OntologyHttpServer") {
    static readonly layer = <E, R>(
        open: Effect.Effect<OntologyHttpServer["Service"] | OntologyServer<R>, E, R>
    ) =>
        Layer.effect(
            OntologyHttpServer,
            Effect.flatMap(open, (server) =>
                "_tag" in server
                    ? Effect.map(makeOntologyHttpHandler(server), (handleRequest) => ({ handleRequest }))
                    : Effect.succeed(server)
            )
        );
}

/** Standard Effect Web-handler bridge. Share this owner until shutdown/HMR;
 * request and response scopes, including streamed bodies, remain Effect-owned.
 */
export const toWebHandler = <E>(layer: Layer.Layer<OntologyHttpServer, E>) =>
    HttpEffect.toWebHandlerLayer(
        Effect.flatMap(OntologyHttpServer, (server) => HttpEffect.fromWebHandler(server.handleRequest)).pipe(
            Effect.interruptible
        ),
        layer
    );
