import { validate } from "@party-stack/ontology-spec";
import metaOntology from "@party-stack/ontology-spec/meta";
import * as q from "@party-stack/ontology-spec/query";
import { and, inArray, field, evaluateQuery } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import { makeOntologyBackend } from "./query.js";
import { compileObjectSubset, objectSubset } from "./subset.js";
import { BackendError } from "./index.js";
import type { OntologyBackendService } from "./index.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type {
    ActionType,
    ObjectType,
    QueryFunctionType,
    TypeDef,
    Ontology as OntologyDescriptor,
} from "@party-stack/ontology-spec/meta";
import type { Scope } from "effect";

function getValueTypes(type: TypeDef): string[] {
    switch (type.kind) {
        case "list":
            return getValueTypes(type.value.elementType);
        case "map":
            return [...getValueTypes(type.value.keyType), ...getValueTypes(type.value.valueType)];
        case "optional":
            return getValueTypes(type.value.type);
        case "encrypted":
            return getValueTypes(type.value.type);
        case "result":
            return [...getValueTypes(type.value.okType), ...getValueTypes(type.value.errType)];
        case "struct":
            return type.value.fields.flatMap((field) => getValueTypes(field.type));
        case "union":
            return type.value.variants.flatMap((variant) => getValueTypes(variant.type));
        case "ref":
            return [type.value.name];
        default:
            return [];
    }
}

function getObjectTypeValueTypes(objectType: ObjectType): string[] {
    return Array.from(new Set(objectType.properties.flatMap((p) => getValueTypes(p.type))));
}

function getActionTypeValueTypes(actionType: ActionType): string[] {
    return [
        ...actionType.parameters.flatMap((parameter) => getValueTypes(parameter.type)),
        ...(actionType.returnType ? getValueTypes(actionType.returnType) : []),
    ];
}

function getQueryFunctionTypeValueTypes(queryFunctionType: QueryFunctionType): string[] {
    return [
        ...queryFunctionType.parameters.flatMap((parameter) => getValueTypes(parameter.type)),
        ...getValueTypes(queryFunctionType.returnType),
    ];
}

export interface PullOptions {
    /** Omitted selects all definitions of this kind; an empty array selects none. */
    objectTypeNames?: string[];
    actionTypeNames?: string[];
    queryFunctionTypeNames?: string[];
    /** App-specific definition edits, applied before the final IR validation. */
    transformPulledOntology?: (ontology: OntologyIR) => OntologyIR | Promise<OntologyIR>;
}

/** Pull selected definitions directly from a metadata backend, without a replica or UI collections. */
export const pull = Effect.fn("Metadata.pull")(function* (
    backend: Pick<OntologyBackendService, "query">,
    options: PullOptions = {}
) {
    const select = (objectType: string, scan: Parameters<typeof objectSubset>[1]) => ({
        ...objectSubset(objectType, scan),
        select: metaOntology.objectTypes
            .find((type) => type.name === objectType)!
            .properties.map((property) => q.selectField(property.name, q.field("row", property.name))),
    });
    const load = Effect.fnUntraced(function* <A>(
        objectType: string,
        scan: Parameters<typeof objectSubset>[1]
    ) {
        const result = yield* backend.query({ select: [q.sub("rows", select(objectType, scan))] });
        return result.rows as A[];
    });
    const { objectTypeNames, actionTypeNames, queryFunctionTypeNames } = options;
    const result = yield* backend.query({
        select: [
            q.sub(
                "objectTypes",
                select("ObjectType", { where: objectTypeNames && inArray(field("name"), objectTypeNames) })
            ),
            q.sub(
                "descriptors",
                select("Ontology", { orderBy: [{ field: field("id"), direction: "asc" }], limit: 2 })
            ),
            q.sub(
                "linkTypes",
                select("LinkType", {
                    where:
                        objectTypeNames &&
                        and(
                            inArray(field("source", "objectType"), objectTypeNames),
                            inArray(field("target", "objectType"), objectTypeNames)
                        ),
                })
            ),
            q.sub(
                "actionTypes",
                select("ActionType", { where: actionTypeNames && inArray(field("name"), actionTypeNames) })
            ),
            q.sub(
                "queryFunctionTypes",
                select("QueryFunctionType", {
                    where: queryFunctionTypeNames && inArray(field("name"), queryFunctionTypeNames),
                })
            ),
        ],
    });
    const objectTypes = result.objectTypes as ObjectType[];
    const descriptors = result.descriptors as OntologyDescriptor[];
    const linkTypes = result.linkTypes as OntologyIR["linkTypes"];
    const actionTypes = result.actionTypes as ActionType[];
    const queryFunctionTypes = result.queryFunctionTypes as QueryFunctionType[];
    const invalid = (message: string) =>
        new BackendError({ operation: "metadata.pull", kind: "InvalidResponse", retryable: false, message });
    if (descriptors.length !== 1 || descriptors[0]?.id !== "ontology")
        return yield* invalid("Metadata must expose exactly one Ontology descriptor with id ontology.");
    const descriptor = descriptors[0];

    for (const [kind, requested, definitions] of [
        ["object types", objectTypeNames, objectTypes],
        ["action types", actionTypeNames, actionTypes],
        ["query function types", queryFunctionTypeNames, queryFunctionTypes],
    ] as const) {
        if (!requested) continue;
        const returned = new Set(definitions.map((definition) => definition.name));
        const missing = [...new Set(requested)].filter((name) => !returned.has(name));
        if (missing.length)
            return yield* invalid(`Missing requested metadata ${kind}: ${missing.join(", ")}.`);
    }

    const valueTypeNames = Array.from(
        new Set([
            ...objectTypes.flatMap(getObjectTypeValueTypes),
            ...actionTypes.flatMap(getActionTypeValueTypes),
            ...queryFunctionTypes.flatMap(getQueryFunctionTypeValueTypes),
            ...(descriptor?.context?.type ? getValueTypes(descriptor.context.type) : []),
        ])
    );

    const types: OntologyIR["types"] = [];
    const loaded = new Set<string>();
    let pending = valueTypeNames;
    while (pending.length) {
        const batch = yield* load<OntologyIR["types"][number]>("ValueType", {
            where: inArray(field("name"), pending),
        });
        for (const type of batch) {
            loaded.add(type.name);
            types.push(type);
        }
        const missing = pending.filter((name) => !loaded.has(name));
        if (missing.length) return yield* invalid(`Missing metadata value types: ${missing.join(", ")}.`);
        pending = [...new Set(batch.flatMap((type) => getValueTypes(type.type)))].filter(
            (name) => !loaded.has(name)
        );
    }

    const pulled: OntologyIR = {
        types,
        objectTypes,
        linkTypes,
        actionTypes,
        queryFunctionTypes,
        ...(descriptor?.displayName === undefined ? {} : { displayName: descriptor.displayName }),
        ...(descriptor?.description === undefined ? {} : { description: descriptor.description }),
        ...(descriptor?.context === undefined ? {} : { context: descriptor.context }),
        ...(descriptor?.policy === undefined ? {} : { policy: descriptor.policy }),
    };
    const definition = options.transformPulledOntology
        ? yield* Effect.tryPromise({
              try: async () => options.transformPulledOntology!(pulled),
              catch: (cause) =>
                  new BackendError({
                      operation: "metadata.pull.transform",
                      kind: "InvalidConfiguration",
                      retryable: false,
                      message: cause instanceof Error ? cause.message : "The ontology transform failed.",
                      cause,
                  }),
          })
        : pulled;
    const valid = validate(definition);
    if (valid.kind === "err")
        return yield* new BackendError({
            operation: "metadata.pull",
            kind: options.transformPulledOntology ? "InvalidConfiguration" : "InvalidResponse",
            retryable: false,
            message: `Pulled ontology is incomplete or invalid: ${valid.value.map((issue) => issue.message).join(" ")}`,
        });
    return definition;
});

/** Assemble a runtime definition through ordinary metadata queries. Completeness
 * is the adapter's query contract; this does not invent an atomic provider revision.
 */
export const loadDefinition = (backend: Pick<OntologyBackendService, "query">) => pull(backend);

function localId(kind: "ActionType" | "ObjectType" | "Property", name: string): string {
    return `local:${kind}:${encodeURIComponent(name)}`;
}

export function makeMetadataBackend(ir: OntologyIR): OntologyBackendService {
    ir = structuredClone(ir);
    const objectTypes: ObjectType[] = ir.objectTypes.map((objectType) => ({
        ...objectType,
        id: localId("ObjectType", objectType.name),
        properties: objectType.properties.map((property) => ({
            ...property,
            id: localId("Property", `${objectType.name}.${property.name}`),
        })),
    }));
    const actionTypes: ActionType[] = ir.actionTypes.map((actionType) => ({
        ...actionType,
        id: localId("ActionType", actionType.name),
    }));

    return makeOntologyBackend({
        ir: metaOntology,
        name: "local-metadata",
        sourceId: "local-metadata",
        supportsIdempotency: false,
        loadSubset: (request) =>
            Effect.flatMap(compileObjectSubset(metaOntology, request), (subset) =>
                Effect.suspend(() => {
                    const rows: Record<string, readonly object[]> = {
                        Ontology: [
                            {
                                id: "ontology",
                                displayName: ir.displayName,
                                description: ir.description,
                                context: ir.context,
                                policy: ir.policy,
                            },
                        ],
                        ObjectType: objectTypes,
                        ValueType: ir.types,
                        LinkType: ir.linkTypes,
                        ActionType: actionTypes,
                        QueryFunctionType: ir.queryFunctionTypes,
                    };
                    const type = metaOntology.objectTypes.find((type) => type.name === subset.objectType);
                    if (!type)
                        return Effect.fail(
                            new BackendError({
                                operation: "loadSubset",
                                kind: "InvalidRequest",
                                message: "Unknown metadata object type.",
                                retryable: false,
                            })
                        );
                    return Effect.succeed({
                        rows: evaluateQuery(
                            rows[subset.objectType]!.map((row) => ({
                                key: (row as Record<string, unknown>)[type.primaryKey] as string,
                                value: row as Record<string, unknown>,
                            })),
                            subset.query ?? {}
                        ),
                        complete: true,
                    });
                })
            ),
        applyAction: () =>
            Effect.fail(
                new BackendError({
                    operation: "applyAction",
                    kind: "NotImplemented",
                    message: "Metadata is read-only.",
                    retryable: false,
                })
            ),
        queryFunction: () =>
            Effect.fail(
                new BackendError({
                    operation: "queryFunction",
                    kind: "NotImplemented",
                    message: "Local metadata has no query functions.",
                    retryable: false,
                })
            ),
    });
}

export interface OntologyPullConfig<R = never> extends Omit<PullOptions, "queryFunctionTypeNames"> {
    readonly queryFunctionTypeNames?: string[];
    readonly backend: Effect.Effect<OntologyBackendService, BackendError, R | Scope.Scope>;
}
