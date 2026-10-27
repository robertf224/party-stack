import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { evaluateQuery } from "@party-stack/ontology-storage";
import { isField } from "@party-stack/ontology-storage/tables";
import { Effect, Schema } from "effect";
import { searchSalesforceObjects } from "./salesforceObjectSearch.js";
import { quoteSoqlIdentifier, serializeSoqlLiteral } from "./soql.js";
import type {
    ActionRequest,
    ActionReceipt,
    BackendSubset,
    OntologyBackendService,
} from "@party-stack/ontology-backend";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { SalesforceClient } from "@party-stack/salesforce-client";

const KeySchema = Schema.Union([Schema.String, Schema.Finite]);

/** Native protocol binding. It never acquires private TanStack collections. */
export function makeSalesforceBackend(options: {
    readonly client: SalesforceClient;
    readonly ir: OntologyIR;
    readonly decodeObject: (objectType: string, object: Record<string, unknown>) => Record<string, unknown>;
    readonly submitAction: (
        name: string,
        parameters: Record<string, unknown>,
        client: SalesforceClient
    ) => Promise<Pick<ActionReceipt, "affected" | "affectedComplete">>;
    readonly runQueryFunction: (
        name: string,
        parameters: Record<string, unknown>,
        client: SalesforceClient
    ) => Promise<unknown>;
    readonly isRejected: (cause: unknown) => boolean;
}): OntologyBackendService {
    const failure = (operation: string, cause: unknown) => {
        if (cause instanceof BackendError) return cause;
        const classified = classifyBackendFailure(operation, cause);
        if (classified.kind !== "Unavailable") return classified;
        const rejected = options.isRejected(cause);
        return new BackendError({
            operation,
            kind: rejected ? "ValidationFailed" : "Unavailable",
            message:
                rejected && cause instanceof Error
                    ? cause.message
                    : "Salesforce operation could not be confirmed.",
            retryable: !rejected,
            cause,
        });
    };
    const clientFor = (signal: AbortSignal) => options.client.withSignal?.(signal) ?? options.client;
    return {
        name: "salesforce",
        sourceId: `salesforce:${options.client.instanceUrl}`,
        supportsIdempotency: false,
        loadSubset: Effect.fn("Salesforce.loadSubset")(function* (subset: BackendSubset) {
            yield* Effect.annotateCurrentSpan("objectType", subset.objectType);
            const definition = options.ir.objectTypes.find((type) => type.name === subset.objectType);
            if (!definition)
                return yield* new BackendError({
                    operation: "salesforce.loadSubset",
                    kind: "ValidationFailed",
                    message: "Unknown Salesforce object type.",
                    retryable: false,
                });
            const predicate = subset.query?.where;
            const candidates =
                predicate?.op === "in" &&
                isField(predicate.left) &&
                predicate.left.path.length === 1 &&
                predicate.left.path[0] === definition.primaryKey
                    ? predicate.values
                    : predicate?.op === "eq" &&
                        isField(predicate.left) &&
                        predicate.left.path.length === 1 &&
                        predicate.left.path[0] === definition.primaryKey &&
                        !isField(predicate.right)
                      ? [predicate.right]
                      : undefined;
            const keys = candidates?.every(Schema.is(KeySchema))
                ? (candidates as readonly (string | number)[])
                : undefined;
            const values = yield* Effect.tryPromise({
                try: (signal) =>
                    searchSalesforceObjects(
                        options.client,
                        subset.objectType,
                        [...new Set([definition.primaryKey, ...definition.properties.map((p) => p.name)])],
                        {
                            signal,
                            where: keys
                                ? {
                                      alwaysFalse: keys.length === 0,
                                      clause: `${quoteSoqlIdentifier(definition.primaryKey)} IN (${[
                                          ...new Set(keys),
                                      ]
                                          .map(serializeSoqlLiteral)
                                          .join(", ")})`,
                                  }
                                : undefined,
                        },
                        (value) => options.decodeObject(subset.objectType, value)
                    ),
                catch: (cause) => failure("salesforce.loadSubset", cause),
            });
            const rows = yield* Effect.forEach(values, (value) =>
                Schema.decodeUnknownEffect(KeySchema)(value[definition.primaryKey]).pipe(
                    Effect.map((key) => ({ key, value })),
                    Effect.mapError((cause) => failure("salesforce.loadSubset", cause))
                )
            );
            // Only primary-key predicates are pushed down for now. Apply ordering,
            // cursor and limits after all pages are decoded and filtered locally.
            return {
                rows: evaluateQuery(rows, subset.query ?? {}),
                fetchedRows: values.length,
                complete: true,
            };
        }),
        applyAction: Effect.fn("Salesforce.applyAction")(function* (invocation: ActionRequest) {
            if (invocation.attachmentUploads?.length)
                return yield* new BackendError({
                    operation: "salesforce.applyAction",
                    kind: "NotImplemented",
                    message: "Salesforce attachment uploads are not supported.",
                    retryable: false,
                });
            const targets = yield* Effect.tryPromise({
                try: (signal) =>
                    options.submitAction(invocation.name, invocation.parameters, clientFor(signal)),
                catch: (cause) => failure("salesforce.applyAction", cause),
            });
            return {
                operationId: invocation.id,
                outcome: "committed",
                ...targets,
            } satisfies ActionReceipt;
        }),
        queryFunction: Effect.fn("Salesforce.queryFunction")(function* (
            name: string,
            parameters: Record<string, unknown>
        ) {
            return yield* Effect.tryPromise({
                try: (signal) => options.runQueryFunction(name, parameters, clientFor(signal)),
                catch: (cause) => failure("salesforce.queryFunction", cause),
            });
        }),
        // The client's CDC API cannot yet report stream health/reconnect gaps.
        // Keep Replica's polling repair until that capability can be represented.
    };
}
