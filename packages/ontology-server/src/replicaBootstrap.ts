import { BackendError } from "@party-stack/ontology-backend";
import { contextPartition } from "@party-stack/ontology-spec/utils";
import { ontologyDefinitionContractSignature } from "@party-stack/ontology-storage";
import { Effect, Stream, SubscriptionRef } from "effect";
import type { OntologyServerClient } from "./rpc.js";
import type { OntologyDescription } from "@party-stack/ontology-backend/description";
import type { ReplicaConnection } from "@party-stack/ontology-replica";
import type {
    ReplicaRegistration,
    ReplicaRegistrationCommon,
    makeReplicaPartitionCatalog,
} from "@party-stack/ontology-replica/registry";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { Scope } from "effect";

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
     * definition and, with `onDefinitionChange: "reset"`, follows it when it changes.
     */
    readonly ir?: OntologyIR;
};

const mismatch = (message: string) =>
    new BackendError({ operation: "replica.definition", kind: "SchemaMismatch", retryable: false, message });

const sameContract = (left: OntologyIR, right: OntologyIR) =>
    ontologyDefinitionContractSignature(left) === ontologyDefinitionContractSignature(right);

/**
 * A replica fed by another party-stack server, as a followed registration. It opens under the
 * retained description without a startup `Describe`, opens a protocol client for each
 * definition, and, with `onDefinitionChange: "reset"`, follows the upstream's definition: when
 * the upstream reports a mismatch the client describes it again, and a different definition
 * reopens the replica behind the same handle.
 */
export const upstreamReplicaRegistration = Effect.fn("OntologyServer.upstreamReplica")(function* (
    ontology: string,
    declaration: UpstreamReplicaRegistration,
    catalog: Effect.Success<ReturnType<typeof makeReplicaPartitionCatalog>>
): Effect.fn.Return<ReplicaRegistration, BackendError, Scope.Scope> {
    const { upstream, ir: contract, ...registration } = declaration;
    const follows = declaration.onDefinitionChange === "reset" && !contract;
    const accept = Effect.fnUntraced(function* (description: OntologyDescription) {
        const ir = description.ir;
        if (!ir) return yield* mismatch("The upstream did not supply an ontology definition.");
        if (contextPartition(ir, description.context ?? {}) !== contextPartition(ir, declaration.context))
            return yield* new BackendError({
                operation: "replica.bootstrap",
                kind: "SourceMismatch",
                retryable: false,
                message: "The upstream belongs to a different context partition.",
            });
        if (contract && !sameContract(contract, ir))
            return yield* mismatch("The upstream definition is incompatible with the application contract.");
        return { ...description, ir };
    });

    const stored = yield* catalog.lookup(ontology);
    const cached = stored?.rebuild?.description ?? stored?.bootstrap;
    const retained =
        cached?.ir && contextPartition(cached.ir, declaration.context) === stored!.partition.owner
            ? cached
            : undefined;
    const initial = yield* accept(
        retained ??
            (yield* Effect.scoped(
                Effect.map(upstream.client.ontology(upstream.ontology), (client) => client.description)
            ))
    );
    const current = yield* SubscriptionRef.make(initial);
    // A reopen falls back to the previous definition if the new one cannot open.
    const descriptions = new Map<OntologyIR, OntologyDescription>([[initial.ir, initial]]);
    const adopt = (fresh: OntologyDescription) =>
        Effect.gen(function* () {
            const accepted = yield* accept(fresh);
            const now = yield* SubscriptionRef.get(current);
            if (!follows) {
                if (!sameContract(now.ir, accepted.ir))
                    return yield* mismatch(
                        "The upstream ontology definition is incompatible with this replica."
                    );
                yield* catalog.saveBootstrap(ontology, accepted);
                return;
            }
            descriptions.set(accepted.ir, accepted);
            yield* SubscriptionRef.set(current, accepted);
        });
    const connect = (ir: OntologyIR) =>
        Effect.gen(function* () {
            const description = descriptions.get(ir);
            if (!description)
                return yield* mismatch("The replica has no upstream description for its definition.");
            const client = yield* upstream.client.ontology(upstream.ontology, {
                description,
                validate: adopt,
            });
            // The first description is saved when the catalog opens the partition.
            if (description !== initial)
                yield* catalog
                    .saveBootstrap(ontology, description)
                    .pipe(
                        Effect.catch((error) =>
                            Effect.logWarning("Could not retain the upstream description", error)
                        )
                    );
            return {
                backend: client.backend,
                ...(client.replication.kind === "speculative" ? { source: client.replication.source } : {}),
            } satisfies ReplicaConnection;
        });
    return {
        ...registration,
        context: initial.context ?? {},
        definition: {
            changes: Stream.map(SubscriptionRef.changes(current), (description) => description.ir),
        },
        backend: connect,
        bootstrap: initial,
    } as ReplicaRegistration;
});

export type { OntologyDescription };
