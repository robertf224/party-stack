import { BackendError, type OntologyBackendService, type BackendSubset } from "@party-stack/ontology-backend";
import metaOntology from "@party-stack/ontology-spec/meta";
import { evaluateQuery } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import { convertSalesforceMetaLinkTypes } from "./convertMetaLinkType.js";
import { convertStorageMetaNameQuery } from "./convertMetaLoadSubsetOptions.js";
import { convertSalesforceMetaObjectType } from "./convertMetaObjectType.js";
import { loadSalesforceActionTypes } from "./loadActions.js";
import { describeSObjects } from "./loadEntities.js";
import { loadSalesforceQueryFunctionTypes } from "./loadQueryFunctions.js";
import type { CreateSalesforceMetaOntologyBackendAdapterOpts } from "./createSalesforceMetaOntologyBackendAdapter.js";

const failure = (cause: unknown) =>
    cause instanceof BackendError
        ? cause
        : new BackendError({
              operation: "metadata.load",
              kind: "Unavailable",
              message: "Salesforce metadata could not be loaded.",
              retryable: true,
              cause,
          });
export function makeSalesforceMetadataBackend(
    options: CreateSalesforceMetaOntologyBackendAdapterOpts
): OntologyBackendService {
    const unsupported = (operation: string) =>
        Effect.fail(
            new BackendError({
                operation,
                kind: "NotImplemented",
                message: "Metadata is read-only.",
                retryable: false,
            })
        );
    return {
        name: "salesforce-metadata",
        sourceId: `salesforce-metadata:${options.client.instanceUrl}`,
        supportsIdempotency: false,
        invoke: () => unsupported("invoke"),
        queryFunction: () => unsupported("queryFunction"),
        loadSubset: Effect.fn("SalesforceMetadata.loadSubset")(function* (subset: BackendSubset) {
            const type = metaOntology.objectTypes.find((type) => type.name === subset.objectType);
            if (!type)
                return yield* new BackendError({
                    operation: "loadSubset",
                    kind: "ValidationFailed",
                    message: "Unknown metadata object type.",
                    retryable: false,
                });
            const values = yield* Effect.tryPromise({
                try: async (signal) => {
                    const client = options.client.withSignal?.(signal) ?? options.client;
                    const opts = { ...options, client };
                    const query = convertStorageMetaNameQuery(subset.query);
                    if (subset.objectType === "ValueType") return [];
                    // Windowing belongs after full predicate evaluation, never before residual filtering.
                    if (subset.objectType === "ActionType") return loadSalesforceActionTypes(opts, query);
                    if (subset.objectType === "QueryFunctionType")
                        return loadSalesforceQueryFunctionTypes(opts, query);
                    const allowlist = options.objectTypeNames ? new Set(options.objectTypeNames) : undefined;
                    const names =
                        subset.objectType === "ObjectType" && query.type === "getBatch"
                            ? query.names.filter((name) => !allowlist || allowlist.has(name))
                            : (options.objectTypeNames ??
                              (await client.describeGlobal()).sobjects
                                  .filter((type) => type.queryable)
                                  .map((type) => type.name));
                    const describes = await describeSObjects(client, names);
                    return subset.objectType === "ObjectType"
                        ? describes.map(convertSalesforceMetaObjectType)
                        : convertSalesforceMetaLinkTypes(describes);
                },
                catch: failure,
            });
            return {
                complete: true,
                fetchedRows: values.length,
                rows: yield* Effect.try({
                    try: () =>
                        evaluateQuery(
                            values.map((value) => ({
                                key: (value as unknown as Record<string, unknown>)[type.primaryKey] as string,
                                value: value as unknown as Record<string, unknown>,
                            })),
                            subset.query ?? {}
                        ),
                    catch: failure,
                }),
            };
        }),
    };
}
