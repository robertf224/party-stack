import { ActionTypesV2 } from "@osdk/foundry.ontologies";
import { makeOntologyBackend } from "@party-stack/ontology-backend";
import {
    BackendError,
    classifyBackendFailure,
    type OntologyBackendService,
} from "@party-stack/ontology-backend";
import { compileObjectSubset, objectSubset } from "@party-stack/ontology-backend/subset";
import metaOntology from "@party-stack/ontology-spec/meta";
import { Effect, Redacted, Schema } from "effect";
import { foundryContext } from "../context.js";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import { convertFoundryMetaActionType } from "./convertMetaActionType.js";
import { convertFoundryMetaQueryFunctionType } from "./convertMetaQueryFunctionType.js";
import { loadActionTypesFullMetadata } from "./loadActions.js";
import { loadActionTypeOmsMetadata } from "./loadActionTypeOmsMetadata.js";
import {
    loadFoundryMetaLinkTypes,
    loadFoundryMetaObjectTypes,
    loadFoundryMetaValueTypes,
} from "./loadEntities.js";
import { getQueryFunctionTypes, listQueryFunctionTypes } from "./loadQueryFunctions.js";
import { planMetaLookup } from "./planMetaLookup.js";
import { actionTypeSearchQuery, planActionTypeWindow, searchActionTypeWindow } from "./searchActionTypes.js";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";
import type { Query } from "@party-stack/ontology-storage";

const failure = (operation: string, cause: unknown) => classifyBackendFailure(operation, cause);
export function makeFoundryMetadataBackend(options: {
    client: OntologyClient;
    refetchInterval?: number | false;
}): OntologyBackendService {
    const unsupported = (operation: string) =>
        Effect.fail(
            new BackendError({
                operation,
                kind: "NotImplemented",
                message: "Metadata is read-only.",
                retryable: false,
            })
        );
    // Cleared once Foundry's displayName order is seen to disagree with the engine's.
    let foundryOrderMatches = true;
    return makeOntologyBackend({
        ir: metaOntology,
        name: "foundry-metadata",
        sourceId: `foundry-metadata:${options.client.baseUrl}:${options.client.ontologyRid}`,
        supportsIdempotency: false,
        applyAction: () => unsupported("applyAction"),
        queryFunction: () => unsupported("queryFunction"),
        refresh: () => ({ pollIntervalMs: options.refetchInterval ?? false }),
        loadSubset: Effect.fn("FoundryMetadata.loadSubset")(function* (request: ObjectSubset) {
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
                    rows: [{ key: "ontology", value: { id: "ontology", context: foundryContext } }],
                    fulfilledSubset: objectSubset("Ontology"),
                };
            const candidates = planMetaLookup(subset.query?.where, { name: "name" })?.values;
            const window =
                subset.objectType === "ActionType" && foundryOrderMatches
                    ? planActionTypeWindow(subset.query)
                    : undefined;
            const loaded = yield* Effect.tryPromise({
                try: async (signal): Promise<{ values: object[]; fulfilled?: Query; fetched?: number }> => {
                    const client: OntologyClient = {
                        ...options.client,
                        fetch: (input, init) =>
                            options.client.fetch(input, {
                                ...init,
                                signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
                            }),
                    };
                    if (candidates?.length === 0) return { values: [] };
                    if (subset.objectType === "ActionType") {
                        const windowed = window
                            ? await searchActionTypeWindow(client, subset.query!, window)
                            : undefined;
                        if (window && !windowed) {
                            foundryOrderMatches = false;
                            console.warn(
                                "Foundry ordered action types differently from the local engine; " +
                                    "action type searches will load every match."
                            );
                        }
                        const actions =
                            windowed?.actions ??
                            (await AsyncIterable.toArray(
                                AsyncIterable.fromPagination(
                                    (pageSize, pageToken: string | undefined) =>
                                        ActionTypesV2.search(
                                            client,
                                            client.ontologyRid,
                                            {
                                                where: actionTypeSearchQuery(subset.query?.where),
                                                pageSize,
                                                pageToken,
                                                fuzziness: { type: "off" },
                                            },
                                            { preview: true }
                                        ),
                                    (page) => page.nextPageToken,
                                    (page) => page.data,
                                    100
                                )
                            ));
                        const metadata = await loadActionTypesFullMetadata(client, actions);
                        const oms = await loadActionTypeOmsMetadata(
                            client,
                            metadata.map((value) => value.actionType.rid)
                        );
                        return {
                            values: metadata.map((value) =>
                                convertFoundryMetaActionType(value, oms.get(value.actionType.rid))
                            ),
                            // The leading window, so a later page of the same search is covered too.
                            fulfilled: windowed && {
                                where: subset.query!.where,
                                orderBy: subset.query!.orderBy,
                                limit: window!.size,
                            },
                            fetched: windowed?.fetched,
                        };
                    }
                    if (subset.objectType === "QueryFunctionType") {
                        const types = candidates
                            ? await getQueryFunctionTypes({ client }, candidates)
                            : await listQueryFunctionTypes({ client });
                        return { values: types.map(convertFoundryMetaQueryFunctionType) };
                    }
                    return {
                        values: await (subset.objectType === "ObjectType"
                            ? loadFoundryMetaObjectTypes(client, subset.query?.where)
                            : subset.objectType === "ValueType"
                              ? loadFoundryMetaValueTypes(client, subset.query?.where)
                              : loadFoundryMetaLinkTypes(client, subset.query?.where)),
                    };
                },
                catch: (cause) => failure("metadata.load", cause),
            });
            const values = loaded.values;
            return {
                complete: true,
                fulfilledSubset: objectSubset(
                    subset.objectType,
                    loaded.fulfilled ?? { where: subset.query?.where }
                ),
                fetchedRows: loaded.fetched ?? values.length,
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
                            message: "Foundry returned invalid metadata.",
                            retryable: false,
                            cause: Redacted.make(cause),
                        }),
                }),
            };
        }),
    });
}

export type FoundryMetadataBackendOptions = Parameters<typeof makeFoundryMetadataBackend>[0];
