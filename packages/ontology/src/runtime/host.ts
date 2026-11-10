import { makeReplica } from "@party-stack/ontology-replica";
import { Effect, Fiber } from "effect";
import { createLiveOntologyAttachments } from "../live/attachments/createLiveOntologyAttachments.js";
import { actionMutators } from "./transactions.js";
import type { LiveOntology, LiveOntologyWrites } from "../live/LiveOntology.js";
import type { ConnectionMonitor } from "@party-stack/connect";
import type { BackendError, OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";
import type { ReplicaOptions, ReplicaService } from "@party-stack/ontology-replica";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { Runtime } from "@party-stack/runtime";
import type { Scope } from "effect";
interface ReplicaHostCommonOptions {
    readonly id?: string;
    readonly live?: boolean;
    readonly ir: OntologyIR;
    readonly context: Record<string, unknown>;
    readonly writes?: LiveOntologyWrites;
    readonly authentication?: ConnectionMonitor;
    readonly cache?: ReplicaOptions["cache"];
    readonly demand?: ReplicaOptions["demand"];
    readonly clientSessions?: ReplicaOptions["clientSessions"];
}
/** A native connection can additionally publish speculative parent state. */
export type ReplicaHostOptions = ReplicaHostCommonOptions & {
    readonly backend: OntologyBackendService;
    readonly source?: OntologySource;
};
export interface ReplicaHostService {
    readonly replica: ReplicaService;
    readonly backend: OntologyBackendService;
    readonly attachments: LiveOntology["attachments"];
}

/** Application facade: adapt authoring types and SDK promises around the native scoped host. */
export const makeReplicaHost = Effect.fn("OntologyHost.open")(function* (
    options: ReplicaHostOptions
): Effect.fn.Return<ReplicaHostService, BackendError, Runtime | Scope.Scope> {
    const backend = options.backend;
    const replica = yield* makeReplica({
        id: options.id,
        live: options.live,
        ir: options.ir,
        context: options.context,
        backend,
        source: options.source,
        mutators: actionMutators(options.ir, options.writes?.mutators),
        outbox: options.writes?.outbox,
        authentication: options.authentication,
        cache: options.cache,
        demand: options.demand,
        clientSessions: options.clientSessions,
    });
    const captured = yield* Effect.context<never>();
    const scope = yield* Effect.scope;
    const run = <A>(effect: Effect.Effect<A, BackendError>, signal?: AbortSignal) =>
        Effect.runPromiseWith(captured)(
            Effect.flatMap(Effect.forkIn(effect, scope), (fiber) =>
                Fiber.join(fiber).pipe(Effect.ensuring(Fiber.interrupt(fiber)))
            ),
            { signal }
        );
    return {
        replica,
        backend,
        attachments: createLiveOntologyAttachments({ attachments: replica.attachments, run, scope }),
    };
});
