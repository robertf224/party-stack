import { ActionTypesV2 } from "@osdk/foundry.ontologies";
import { BackendError, type OntologyBackendService, type BackendSubset } from "@party-stack/ontology-backend";
import metaOntology from "@party-stack/ontology-spec/meta";
import { evaluateQuery, type Predicate } from "@party-stack/ontology-storage";
import { isField } from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import { toFoundryActionTypeName } from "../utils/actionTypeName.js";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import { loadActionTypesFullMetadata } from "./actionTypeCollectionOptions.js";
import { convertFoundryMetaActionType } from "./convertMetaActionType.js";
import { convertFoundryMetaQueryFunctionType } from "./convertMetaQueryFunctionType.js";
import { loadFoundryMetaOntology } from "./entityCollectionOptions.js";
import { loadActionTypeOmsMetadata } from "./loadActionTypeOmsMetadata.js";
import { getQueryFunctionTypes, listQueryFunctionTypes } from "./queryFunctionTypeCollectionOptions.js";
import type { ActionTypeSearchJsonQueryV2 } from "@osdk/foundry.ontologies";
import type { OntologyClient } from "@party-stack/foundry-client";

const failure = (operation: string, cause: unknown) =>
    cause instanceof BackendError
        ? cause
        : new BackendError({
              operation,
              kind: "Unavailable",
              message: "Foundry metadata could not be loaded.",
              retryable: true,
              cause,
          });
// Candidate selection is deliberately a superset. Residual predicates are evaluated on decoded metadata.
const names = (predicate?: Predicate): string[] | undefined => {
    if (!predicate) return;
    if (predicate.op === "eq") {
        const value =
            isField(predicate.left) && predicate.left.path.join(".") === "name"
                ? predicate.right
                : isField(predicate.right) && predicate.right.path.join(".") === "name"
                  ? predicate.left
                  : undefined;
        return typeof value === "string" ? [value] : undefined;
    }
    if (
        predicate.op === "in" &&
        isField(predicate.left) &&
        predicate.left.path.join(".") === "name" &&
        predicate.values.every((value) => typeof value === "string")
    )
        return [...predicate.values] as string[];
    if (predicate.op === "and") return predicate.predicates.map(names).find((value) => value !== undefined);
    if (predicate.op === "or") {
        const children = predicate.predicates.map(names);
        if (children.every((value) => value !== undefined)) return [...new Set(children.flat())];
    }
};
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
                kind: "Unsupported",
                message: "Metadata is read-only.",
                retryable: false,
            })
        );
    return {
        name: "foundry-metadata",
        sourceId: `foundry-metadata:${options.client.baseUrl}:${options.client.ontologyRid}`,
        supportsIdempotency: false,
        invoke: () => unsupported("invoke"),
        queryFunction: () => unsupported("queryFunction"),
        pollIntervalMs: () => options.refetchInterval ?? false,
        loadSubset: Effect.fn("FoundryMetadata.loadSubset")(function* (subset: BackendSubset) {
            const type = metaOntology.objectTypes.find((type) => type.name === subset.objectType);
            if (!type)
                return yield* new BackendError({
                    operation: "loadSubset",
                    kind: "Rejected",
                    message: "Unknown metadata object type.",
                    retryable: false,
                });
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
                    const candidates = names(subset.query?.where);
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
                    const metadata = await loadFoundryMetaOntology(client);
                    return subset.objectType === "ObjectType"
                        ? metadata.objectTypes
                        : subset.objectType === "ValueType"
                          ? metadata.valueTypes
                          : metadata.linkTypes;
                },
                catch: (cause) => failure("metadata.load", cause),
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
                    catch: (cause) => failure("metadata.filter", cause),
                }),
            };
        }),
    };
}
