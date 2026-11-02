import { executeAction } from "@party-stack/ontology-backend/actions";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { Effect } from "effect";
import { makeReplicaKernel } from "./engine.js";
import { kernel } from "./internal.js";
import type { ReplicaOptions as KernelOptions, ReplicaService as KernelService } from "./engine.js";
import type { BackendError } from "@party-stack/ontology-backend";
import type { ActionMutatorRegistry } from "@party-stack/ontology-backend/actions";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";
import type { Scope } from "effect";
type Configuration<T> = T extends unknown ? Omit<T, "execute" | "onReceipt" | "publish"> : never;
export type ReplicaOptions = Configuration<KernelOptions> & {
    readonly context?: Record<string, unknown>;
    readonly mutators?: ActionMutatorRegistry;
};
export interface ReplicaService extends Omit<
    KernelService,
    "demand" | "syncSubset" | "forwardParentActions" | "outboxWakeups"
> {
    readonly [kernel]: KernelService;
    readonly demand: {
        readonly acquire: (subset: ObjectSubset) => Effect.Effect<void, BackendError, Scope.Scope>;
    };
}
export const makeReplica = Effect.fn("Replica.open")(function* (
    options: ReplicaOptions
): Effect.fn.Return<ReplicaService, BackendError, Scope.Scope> {
    const engine = yield* makeReplicaKernel({
        ...options,
        execute: (tx, request, settings) =>
            executeAction({
                ir: options.ir,
                tx,
                request,
                context: options.context,
                mutators: options.mutators,
                resolveOnly: settings?.optimistic === false,
            }),
    });
    return {
        ...engine,
        [kernel]: engine,
        demand: {
            acquire: Effect.fn("Replica.demand")(function* (subset: ObjectSubset) {
                const compiled = yield* compileObjectSubset(options.ir, subset, options.context);
                yield* engine.demand(compiled);
                yield* engine.syncSubset(compiled);
            }),
        },
    } satisfies ReplicaService;
});
