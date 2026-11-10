import { BackendError } from "@party-stack/ontology-backend";
import { contextPartition } from "@party-stack/ontology-spec/utils";
import { ontologyDefinitionContractSignature } from "@party-stack/ontology-storage";
import { Deferred, Effect } from "effect";
import type { OntologyClient, OntologyServerClient } from "./rpc.js";
import type { OntologyDescription } from "@party-stack/ontology-backend/description";
import type {
    ReplicaRegistration,
    makeReplicaPartitionCatalog,
} from "@party-stack/ontology-replica/registry";
import type { OntologyIR } from "@party-stack/ontology-spec";

export interface ReplicaDefinitionOptions {
    /** Optional application contract. Cached remote metadata can otherwise supply the IR. */
    readonly ir?: OntologyIR;
    /** Pending actions are preserved; rebuilding waits for explicit migration/resolution of them. */
    readonly onIncompatible?: "error" | "rebuild";
}

export interface ReplicaUpstream {
    readonly client: OntologyServerClient;
    readonly ontology?: string;
}

export type UpstreamReplicaRegistration = Omit<ReplicaRegistration, "ir" | "backend" | "bootstrap"> & {
    readonly upstream: ReplicaUpstream;
    /** Select the local account before opening its retained definition or data. */
    readonly context: Record<string, unknown>;
    readonly definition?: ReplicaDefinitionOptions;
};

const mismatch = (message: string) =>
    new BackendError({ operation: "replica.definition", kind: "SchemaMismatch", retryable: false, message });

const sameContract = (left: OntologyIR, right: OntologyIR) =>
    ontologyDefinitionContractSignature(left) === ontologyDefinitionContractSignature(right);

/** Restore the protocol binding locally. Refresh is explicit or driven by a typed
 * upstream incompatibility; there is no startup Describe/validation barrier.
 */
export const restoreReplicaRegistration = Effect.fn("OntologyServer.restoreReplica")(function* (
    ontology: string,
    declaration: UpstreamReplicaRegistration,
    catalog: Effect.Success<ReturnType<typeof makeReplicaPartitionCatalog>>,
    onIncompatible: (client: OntologyClient, error: BackendError) => Effect.Effect<void>
) {
    const stored = yield* catalog.lookup(ontology);
    const cached = stored?.rebuild?.description ?? stored?.bootstrap;
    const ownerMatches = cached?.ir
        ? contextPartition(cached.ir, declaration.context) === stored!.partition.owner
        : false;
    const description = ownerMatches ? cached : undefined;
    const opened = yield* Deferred.make<void, BackendError>();
    let client: OntologyClient;
    client = yield* declaration.upstream.client.ontology(declaration.upstream.ontology, {
        description,
        validate: (fresh) =>
            Effect.gen(function* () {
                if (!fresh.ir)
                    return yield* mismatch("The upstream no longer supplies an ontology definition.");
                const current = client.ir;
                if (!current || !sameContract(current, fresh.ir))
                    return yield* mismatch(
                        "The upstream ontology definition is incompatible with this replica."
                    );
                if (declaration.definition?.ir && !sameContract(declaration.definition.ir, fresh.ir))
                    return yield* mismatch(
                        "The upstream definition is incompatible with the application contract."
                    );
                yield* Deferred.await(opened);
                yield* catalog.saveBootstrap(ontology, fresh);
            }),
        onIncompatible: (error) => onIncompatible(client, error),
    });
    if (!client.ir) return yield* mismatch("The upstream did not supply an ontology definition.");
    const expectedOwner = contextPartition(client.ir, declaration.context);
    if (contextPartition(client.ir, client.context ?? {}) !== expectedOwner)
        return yield* new BackendError({
            operation: "replica.bootstrap",
            kind: "SourceMismatch",
            retryable: false,
            message: "The upstream belongs to a different context partition.",
        });
    if (declaration.definition?.ir && !sameContract(declaration.definition.ir, client.ir))
        return yield* mismatch("The retained definition is incompatible with the application contract.");
    const registration: ReplicaRegistration = {
        ...declaration,
        ir: client.ir,
        context: client.context ?? {},
        backend: client.backend,
        ...(client.replication.kind === "speculative" ? { source: client.replication.source } : {}),
        bootstrap: client.description,
    };
    return {
        registration,
        client,
        opened: Deferred.succeed(opened, undefined),
        failed: (error: BackendError) => Deferred.fail(opened, error),
    };
});

export type { OntologyDescription };
