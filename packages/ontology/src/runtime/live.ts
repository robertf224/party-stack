import { BackendError } from "@party-stack/ontology-backend";
import { isCoordinationHost, Runtime, runtimeEffects } from "@party-stack/runtime";
import { Effect, Exit, Scope } from "effect";
import { createLiveOntologyAttachments } from "../live/attachments/createLiveOntologyAttachments.js";
import { makeReplicaHost, type ReplicaHostOptions } from "./host.js";
import { makeReplicaOntologyView } from "./view.js";
import type { LiveOntology } from "../live/LiveOntology.js";

const failure = (cause: unknown) =>
    cause instanceof BackendError
        ? cause
        : new BackendError({
              operation: "ontology",
              kind: "Unavailable",
              message: cause instanceof Error ? cause.message : "Ontology operation failed.",
              retryable: true,
              cause,
          });
export type ReplicaLiveOptions = Omit<ReplicaHostOptions, "asLeader">;
/** Primary scoped implementation; only the outer createLiveOntology bridge owns a standalone scope. */
export const makeReplicaLiveOntology = Effect.fn("Ontology.open")(function* (
    options: ReplicaLiveOptions
): Effect.fn.Return<Omit<LiveOntology, "cleanup" | "destroy">, BackendError, Runtime | Scope.Scope> {
    const { runtime, context, ir, backendAdapter } = options;
    const coordination = runtime.coordination;
    const asLeader = (work: Effect.Effect<void, BackendError>) =>
        isCoordinationHost(coordination)
            ? Effect.flatMap(Effect.context<never>(), (context) =>
                  Effect.tryPromise({
                      try: (signal) =>
                          coordination.runAsLeader(
                              ({ signal }) => Effect.runPromiseWith(context)(work, { signal }),
                              { signal }
                          ),
                      catch: failure,
                  })
              )
            : Effect.void;
    const { replica, backend, blobManager, attachmentsAdapter } = yield* makeReplicaHost({
        ...options,
        asLeader,
    });
    return yield* makeReplicaOntologyView({
        ir,
        context,
        replica,
        writes: options.writes,
        queryFunction: backend.queryFunction,
        sourceId: backend.sourceId,
        encrypted: backend.encrypted,
        attachments: createLiveOntologyAttachments({ ir, attachmentsAdapter, blobManager }),
        traces: runtimeEffects(runtime).traces,
        validate: backendAdapter.validateAction
            ? (name, parameters, objects) =>
                  backendAdapter.validateAction!(name, parameters, { objects, context })
            : undefined,
        validateDraft: backendAdapter.validateActionDraft
            ? (name, parameters, knownParameters, objects) =>
                  backendAdapter.validateActionDraft!(name, parameters, { objects, context, knownParameters })
            : undefined,
    });
});

export async function createReplicaLiveOntology(options: ReplicaLiveOptions): Promise<LiveOntology> {
    const { runtime } = runtimeEffects(options.runtime);
    const scope = await runtime.runPromise(Effect.flatMap(Runtime, (service) => Scope.fork(service.scope)));
    try {
        const live = await runtime.runPromise(Scope.provide(makeReplicaLiveOntology(options), scope));
        let closing: Promise<void> | undefined;
        const cleanup = () =>
            (closing ??= Effect.runPromise(
                Scope.close(scope, Exit.void).pipe(
                    Effect.ensuring(
                        Effect.promise(async () => {
                            await options.runtime.cleanup?.();
                        })
                    )
                )
            ));
        return {
            ...live,
            cleanup,
            destroy: () =>
                cleanup()
                    .then(() => options.runtime.destroy?.())
                    .then(() => undefined),
        };
    } catch (cause) {
        await Effect.runPromise(
            Scope.close(scope, Exit.fail(cause)).pipe(
                Effect.ensuring(
                    Effect.promise(async () => {
                        await options.runtime.cleanup?.();
                    })
                )
            )
        );
        throw cause;
    }
}
