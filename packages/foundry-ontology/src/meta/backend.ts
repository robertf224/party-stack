import { ActionTypesV2 } from "@osdk/foundry.ontologies";
import { makeOntologyBackend } from "@party-stack/ontology-backend";
import {
    BackendError,
    classifyBackendFailure,
    type OntologyBackendService,
} from "@party-stack/ontology-backend";
import { compileObjectSubset, objectSubset } from "@party-stack/ontology-backend/subset";
import metaOntology from "@party-stack/ontology-spec/meta";
import { eq, filterOperand, inValues } from "@party-stack/ontology-storage/tables";
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
import type { Filter, Scalar } from "@party-stack/ontology-storage";

const failure = (operation: string, cause: unknown) => classifyBackendFailure(operation, cause);
function actionCandidates(predicate?: Filter): ActionTypeSearchJsonQueryV2 | undefined {
    if (!predicate) return;
    if (predicate.kind === "and" || predicate.kind === "or") {
        const children = predicate.value.expressions.map(actionCandidates);
        if (predicate.kind === "or" && children.some((child) => child === undefined)) return;
        const supported = children.filter((child) => child !== undefined);
        return supported.length === 1
            ? supported[0]
            : supported.length
              ? { type: predicate.kind, value: supported }
              : undefined;
    }
    if (predicate.kind === "in") {
        const left = predicate.value.left;
        const children = inValues(predicate).map((value) => actionCandidates(eq(left, value as Scalar)));
        if (children.every((child) => child !== undefined)) return { type: "or", value: children };
        return;
    }
    if (predicate.kind !== "eq" && predicate.kind !== "like" && predicate.kind !== "ilike") return;
    const left = filterOperand(predicate.value.left);
    const right = filterOperand(predicate.value.right);
    const [ref, other] = left?.kind === "field" ? [left, right] : [right, left];
    if (ref?.kind !== "field" || other?.kind !== "literal" || typeof other.value !== "string") return;
    const value = other.value;
    const field = ref.field.path.join(".");
    if (predicate.kind === "eq" && field === "id") return { type: "actionTypeRid", value };
    if (field !== "name" && field !== "displayName") return;
    const type = field === "name" ? ("actionTypeApiName" as const) : ("actionTypeDisplayName" as const);
    const convert = (value: string) => (field === "name" ? toFoundryActionTypeName(value) : value);
    if (predicate.kind === "eq") return { type, value: { type: "exact", value: convert(value) } };
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
