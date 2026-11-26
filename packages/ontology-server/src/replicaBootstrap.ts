import { BackendError } from "@party-stack/ontology-backend";
import { withDefinitionHints } from "@party-stack/ontology-replica/infrastructure";
import { ontologyDefinitionContractHash } from "@party-stack/ontology-storage";
import { Effect, Option, PubSub, Ref, Scope, Stream, SynchronizedRef } from "effect";
import type { OntologyClient, OntologyServerClient } from "./rpc.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologyDescription } from "@party-stack/ontology-backend/description";
import type { ReplicaConnection } from "@party-stack/ontology-replica";
import type {
    ReplicaRegistration,
    ReplicaRegistrationCommon,
    makeReplicaPartitionCatalog,
} from "@party-stack/ontology-replica/registry";
import type { OntologyIR } from "@party-stack/ontology-spec";

export interface ReplicaUpstream {
    readonly client: OntologyServerClient;
    readonly ontology?: string;
}

export type UpstreamReplicaRegistration = Omit<ReplicaRegistrationCommon, "context"> & {
    readonly upstream: ReplicaUpstream;
    /** Select the local account before opening its retained definition or data. */
    readonly context: Record<string, unknown>;
    /**
     * The application's contract, when it has one. The upstream's definition must match it, and
     * `onDefinitionChange` never replaces it. Without it, the replica takes the upstream's
     * definition, and with `onDefinitionChange: "reset"` follows it as it changes.
     */
    readonly ir?: OntologyIR;
};

const mismatch = (message: string) =>
    new BackendError({ operation: "replica.definition", kind: "SchemaMismatch", retryable: false, message });

const sameValue = (left: unknown, right: unknown) => {
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch {
        return false;
    }
};

/**
 * The upstream's `meta` resource as a backend the replica can open before the upstream is
 * reachable: it connects on first use, and again after a failed connection.
 */
const lazyMetaBackend = Effect.fnUntraced(function* (upstream: ReplicaUpstream, sourceId: string) {
    const scope = yield* Effect.scope;
    const connected = yield* SynchronizedRef.make(Option.none<OntologyClient>());
    const client = SynchronizedRef.modifyEffect(connected, (current) =>
        Option.isSome(current)
            ? Effect.succeed([current.value, current] as const)
            : Effect.map(
                  Scope.provide(upstream.client.ontology(upstream.ontology, { resource: "meta" }), scope),
                  (opened) => [opened, Option.some(opened)] as const
              )
    );
    const backend = Effect.map(client, (opened) => opened.backend);
    const readOnly = (operation: string) =>
        Effect.fail(
            new BackendError({
                operation,
                kind: "NotImplemented",
                retryable: false,
                message: "Metadata is read-only.",
            })
        );
    return {
        name: "upstream-metadata",
        sourceId: `${sourceId}#meta`,
        supportsIdempotency: false,
        loadSubset: (subset) => Effect.flatMap(backend, (meta) => meta.loadSubset(subset)),
        query: (document, settings) => Effect.flatMap(backend, (meta) => meta.query(document, settings)),
        // Without a watch on the upstream, the endpoint closing ends this stream and the
        // replica watches again.
        watchSubset: (subset) =>
            Effect.flatMap(backend, (meta) => meta.watchSubset?.(subset) ?? Effect.succeed(Stream.never)),
        applyAction: () => readOnly("applyAction"),
        queryFunction: () => readOnly("queryFunction"),
    } satisfies OntologyBackendService;
});

/**
 * A replica fed by another party-stack server. It reopens its partition from the retained
 * binding (the upstream's description) without contacting the upstream. Without an application
 * contract its definition is dynamic: read from the upstream's `meta` resource through a meta
 * replica in the same storage, so it starts offline and follows the upstream's definition.
 */
export const upstreamReplicaRegistration = Effect.fn("OntologyServer.upstreamReplica")(function* (
    ontology: string,
    declaration: UpstreamReplicaRegistration,
    catalog: Effect.Success<ReturnType<typeof makeReplicaPartitionCatalog>>
): Effect.fn.Return<ReplicaRegistration, BackendError, Scope.Scope> {
    const { upstream, ir: contract, ...registration } = declaration;
    const stored = yield* catalog.lookup(ontology);
    const retained =
        stored?.bootstrap && (stored.context === undefined || sameValue(stored.context, declaration.context))
            ? stored.bootstrap
            : undefined;
    const initial =
        retained ??
        (yield* Effect.scoped(
            Effect.map(upstream.client.ontology(upstream.ontology), (client) => client.description)
        ));
    if (contract && initial.contractHash !== undefined) {
        const expected = yield* Effect.orElseSucceed(
            ontologyDefinitionContractHash(contract),
            () => undefined
        );
        if (expected !== initial.contractHash)
            return yield* mismatch("The upstream definition is incompatible with the application contract.");
    }
    // The latest accepted binding. Capabilities may change while the definition does not.
    const binding = yield* Ref.make(initial);
    const follows = declaration.onDefinitionChange === "reset" && !contract;
    const changed = yield* PubSub.unbounded<void>();
    const connect = (ir: OntologyIR) =>
        Effect.gen(function* () {
            const accepted = yield* Ref.get(binding);
            const client = yield* upstream.client.ontology(upstream.ontology, {
                description: accepted,
                ir,
                // Keep the refreshed binding. A different definition is followed: the replica
                // reads it from the upstream's metadata and reopens. Otherwise it is a mismatch.
                validate: (fresh) =>
                    Effect.gen(function* () {
                        const expected = yield* Effect.orElseSucceed(
                            ontologyDefinitionContractHash(ir),
                            () => undefined
                        );
                        if (fresh.contractHash !== expected) {
                            if (!follows) return yield* mismatch("The upstream ontology definition changed.");
                            yield* PubSub.publish(changed, undefined);
                        }
                        yield* Ref.set(binding, fresh);
                        yield* catalog
                            .saveBootstrap(ontology, fresh)
                            .pipe(
                                Effect.catch((error) =>
                                    Effect.logWarning("Could not retain the upstream description", error)
                                )
                            );
                    }),
            });
            // Following the definition status checks the upstream's binding as it changes.
            yield* client.definition.changes.pipe(Stream.runDrain, Effect.forkScoped);
            return {
                backend: client.backend,
                ...(client.replication.kind === "speculative" ? { source: client.replication.source } : {}),
            } satisfies ReplicaConnection;
        });
    return {
        ...registration,
        context: initial.context ?? {},
        definition: contract
            ? { kind: "static", ir: contract }
            : // A newer description seen by the replica's client revalidates its metadata, also
              // for upstreams without realtime and for one-shot replicas.
              withDefinitionHints(
                  { kind: "dynamic", meta: yield* lazyMetaBackend(upstream, initial.sourceId) },
                  Stream.fromPubSub(changed)
              ),
        backend: connect,
        bootstrap: initial,
    } satisfies ReplicaRegistration;
});

export type { OntologyDescription };
