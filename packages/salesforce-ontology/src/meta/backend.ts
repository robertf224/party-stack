import {
    BackendError,
    classifyBackendFailure,
    type OntologyBackendService,
} from "@party-stack/ontology-backend";
import { compileObjectSubset, objectSubset } from "@party-stack/ontology-backend/subset";
import metaOntology from "@party-stack/ontology-spec/meta";
import { Effect, Redacted, Schema } from "effect";
import { convertSalesforceMetaLinkTypes } from "./convertMetaLinkType.js";
import { convertStorageMetaNameQuery } from "./convertMetaLoadSubsetOptions.js";
import { convertSalesforceMetaObjectType } from "./convertMetaObjectType.js";
import { loadSalesforceActionTypes } from "./loadActions.js";
import { describeSObjects } from "./loadEntities.js";
import { loadSalesforceQueryFunctionTypes } from "./loadQueryFunctions.js";
import type { CreateSalesforceMetaOntologyBackendAdapterOpts } from "./createSalesforceMetaOntologyBackendAdapter.js";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";

const failure = (cause: unknown) => classifyBackendFailure("metadata.load", cause);
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
        applyAction: () => unsupported("applyAction"),
        queryFunction: () => unsupported("queryFunction"),
        loadSubset: Effect.fn("SalesforceMetadata.loadSubset")(function* (request: ObjectSubset) {
            const subset = yield* compileObjectSubset(metaOntology, request, undefined);
            const type = metaOntology.objectTypes.find((type) => type.name === subset.objectType);
            if (!type)
                return yield* new BackendError({
                    operation: "loadSubset",
                    kind: "InvalidRequest",
                    message: "Unknown metadata object type.",
                    retryable: false,
                });
            if (subset.objectType === "Ontology")
                return {
                    complete: true,
                    rows: [{ key: "ontology", value: { id: "ontology" } }],
                    fulfilledSubset: objectSubset("Ontology"),
                };
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
                fulfilledSubset: objectSubset(subset.objectType, {
                    where:
                        (subset.objectType === "ObjectType" &&
                            convertStorageMetaNameQuery(subset.query).type !== "getBatch") ||
                        subset.objectType === "LinkType" ||
                        subset.objectType === "ValueType"
                            ? undefined
                            : subset.query?.where,
                }),
                fetchedRows: values.length,
                rows: yield* Effect.try({
                    try: () =>
                        values.map((value) => ({
                            key: Schema.decodeUnknownSync(Schema.Union([Schema.String, Schema.Finite]))(
                                (value as unknown as Record<string, unknown>)[type.primaryKey]
                            ),
                            value: value as unknown as Record<string, unknown>,
                        })),
                    catch: (cause) =>
                        new BackendError({
                            operation: "metadata.decode",
                            kind: "InvalidResponse",
                            message: "Salesforce returned invalid metadata.",
                            retryable: false,
                            cause: Redacted.make(cause),
                        }),
                }),
            };
        }),
    };
}
