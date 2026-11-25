import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { ontologyDefinitionContractHash } from "@party-stack/ontology-storage";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { Headers } from "effect/http/Headers";

export const expectedSourceHeader = "x-party-stack-expected-source";
export const expectedContextHeader = "x-party-stack-expected-context";
/** The contract hash of the definition the client accepted. */
export const expectedDefinitionHeader = "x-party-stack-expected-definition";
const contractHashes = new WeakMap<OntologyIR, string>();
/** Hashed once per definition: every fenced request compares against it. */
const contractHash = (ir: OntologyIR) => {
    const known = contractHashes.get(ir);
    return known !== undefined
        ? Effect.succeed(known)
        : ontologyDefinitionContractHash(ir).pipe(
              Effect.tap((hash) => Effect.sync(() => contractHashes.set(ir, hash))),
              Effect.mapError((cause) => classifyBackendFailure("ontology.binding", cause))
          );
};
const identity = Table.make<unknown>({ name: "ontology-binding-identity" });
const contextIdentity = (context: Record<string, unknown> | undefined) =>
    encodeURIComponent(identity.encode(context ?? {}));

/** Expectations constrain the already authenticated binding; they never grant authority. */
export const expectedBindingHeaders = (binding: {
    readonly sourceId: string;
    readonly context?: Record<string, unknown>;
}): Record<string, string> => ({
    [expectedSourceHeader]: encodeURIComponent(binding.sourceId),
    [expectedContextHeader]: contextIdentity(binding.context),
});

/** The same fence protects RPC and HTTP byte/action sidechannels before provider work. */
export const withExpectedBinding = <R, Q extends { readonly operation: string }>(options: {
    readonly source?: { readonly sourceId: string };
    readonly backend?: { readonly sourceId: string };
    readonly context?: Record<string, unknown>;
    /** The definition this endpoint serves. A request bound to another contract is rejected. */
    readonly ir?: OntologyIR;
    readonly ready?: Effect.Effect<void, BackendError, R>;
    readonly authorize: (request: Q, headers: Headers) => Effect.Effect<void, BackendError, R>;
}) =>
    Effect.fnUntraced(function* (request: Q, headers: Headers): Effect.fn.Return<void, BackendError, R> {
        if (
            request.operation !== "Describe" &&
            (headers[expectedSourceHeader] !== undefined ||
                headers[expectedContextHeader] !== undefined ||
                headers[expectedDefinitionHeader] !== undefined)
        ) {
            yield* options.ready ?? Effect.void;
            const expected = expectedBindingHeaders({
                sourceId: options.source?.sourceId ?? options.backend?.sourceId ?? "stateless",
                context: options.context,
            });
            if (
                (headers[expectedSourceHeader] !== undefined &&
                    headers[expectedSourceHeader] !== expected[expectedSourceHeader]) ||
                (headers[expectedContextHeader] !== undefined &&
                    headers[expectedContextHeader] !== expected[expectedContextHeader])
            )
                return yield* new BackendError({
                    operation: "ontology.binding",
                    kind: "SourceMismatch",
                    retryable: false,
                    message: "The ontology source or authenticated context changed.",
                    ...(["ApplyAction", "Submit", "Accept"].includes(request.operation)
                        ? { actionOutcome: "not-committed" as const }
                        : {}),
                });
            // A followed replica that reopened under a new definition serves it from a new
            // endpoint; a client bound to the old contract learns it changed.
            const definition = headers[expectedDefinitionHeader];
            if (definition !== undefined && options.ir && definition !== (yield* contractHash(options.ir)))
                return yield* new BackendError({
                    operation: "ontology.binding",
                    kind: "SchemaMismatch",
                    retryable: false,
                    message: "The ontology definition changed.",
                    ...(["ApplyAction", "Submit", "Accept"].includes(request.operation)
                        ? { actionOutcome: "not-committed" as const }
                        : {}),
                });
        }
        yield* options.authorize(request, headers);
    });
