import { ActionTypesV2 } from "@osdk/foundry.ontologies";
import { makeOntologyBackend } from "@party-stack/ontology-backend";
import {
    BackendError,
    classifyBackendFailure,
    type OntologyBackendService,
} from "@party-stack/ontology-backend";
import { compileObjectSubset, objectSubset } from "@party-stack/ontology-backend/subset";
import metaOntology from "@party-stack/ontology-spec/meta";
import { isField } from "@party-stack/ontology-storage/tables";
import { Effect, Redacted, Schema } from "effect";
import { foundryContext } from "../context.js";
import { toFoundryActionTypeName } from "../utils/actionTypeName.js";
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
import type { ActionTypeSearchJsonQueryV2 } from "@osdk/foundry.ontologies";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";
import type { Predicate } from "@party-stack/ontology-storage";

const failure = (operation: string, cause: unknown) => classifyBackendFailure(operation, cause);
function actionCandidates(predicate?: Predicate): ActionTypeSearchJsonQueryV2 | undefined {
    if (!predicate) return;
    if (predicate.op === "and" || predicate.op === "or") {
        const children = predicate.predicates.map(actionCandidates);
        if (predicate.op === "or" && children.some((child) => child === undefined)) return;
        const supported = children.filter((child) => child !== undefined);
        return supported.length === 1
            ? supported[0]
            : supported.length
              ? { type: predicate.op, value: supported }
              : undefined;
    }
    if (predicate.op === "in") {
        const children = predicate.values.map((value) =>
            actionCandidates({ op: "eq", left: predicate.left, right: value })
        );
        if (children.every((child) => child !== undefined)) return { type: "or", value: children };
        return;
    }
    if (predicate.op !== "eq" && predicate.op !== "like" && predicate.op !== "ilike") return;
    const ref = isField(predicate.left) ? predicate.left : predicate.right;
    const value = ref === predicate.left ? predicate.right : predicate.left;
    if (!isField(ref) || typeof value !== "string") return;
    const field = ref.path.join(".");
    if (predicate.op === "eq" && field === "id") return { type: "actionTypeRid", value };
    if (field !== "name" && field !== "displayName") return;
    const type = field === "name" ? ("actionTypeApiName" as const) : ("actionTypeDisplayName" as const);
    const convert = (value: string) => (field === "name" ? toFoundryActionTypeName(value) : value);
    if (predicate.op === "eq") return { type, value: { type: "exact", value: convert(value) } };
    if (value.includes("_") || value.includes("\\")) return;
    const children: ActionTypeSearchJsonQueryV2[] = value
        .split("%")
        .filter(Boolean)
        .map((term) => ({ type, value: { type: "contains", value: convert(term) } }));
    return children.length === 1 ? children[0] : { type: "and", value: children };
}
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
            const values = yield* Effect.tryPromise({
                try: async (signal) => {
                    const client: OntologyClient = {
                        ...options.client,
                        fetch: (input, init) =>
                            options.client.fetch(input, {
                                ...init,
                                signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
                            }),
                    };
                    if (candidates?.length === 0) return [];
                    if (subset.objectType === "ActionType") {
                        const where = actionCandidates(subset.query?.where);
                        const actions = await AsyncIterable.toArray(
                            AsyncIterable.fromPagination(
                                (pageSize, pageToken: string | undefined) =>
                                    ActionTypesV2.search(
                                        client,
                                        client.ontologyRid,
                                        { where, pageSize, pageToken, fuzziness: { type: "off" } },
                                        { preview: true }
                                    ),
                                (page) => page.nextPageToken,
                                (page) => page.data,
                                100
                            )
                        );
                        const metadata = await loadActionTypesFullMetadata(client, actions);
                        const oms = await loadActionTypeOmsMetadata(
                            client,
                            metadata.map((value) => value.actionType.rid)
                        );
                        return metadata.map((value) =>
                            convertFoundryMetaActionType(value, oms.get(value.actionType.rid))
                        );
                    }
                    if (subset.objectType === "QueryFunctionType") {
                        const types = candidates
                            ? await getQueryFunctionTypes({ client }, candidates)
                            : await listQueryFunctionTypes({ client });
                        return types.map(convertFoundryMetaQueryFunctionType);
                    }
                    return subset.objectType === "ObjectType"
                        ? loadFoundryMetaObjectTypes(client, subset.query?.where)
                        : subset.objectType === "ValueType"
                          ? loadFoundryMetaValueTypes(client, subset.query?.where)
                          : loadFoundryMetaLinkTypes(client, subset.query?.where);
                },
                catch: (cause) => failure("metadata.load", cause),
            });
            return {
                complete: true,
                fulfilledSubset: objectSubset(subset.objectType, {
                    where: subset.query?.where,
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
