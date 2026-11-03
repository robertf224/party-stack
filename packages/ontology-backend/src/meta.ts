import { validate } from "@party-stack/ontology-spec";
import metaOntology from "@party-stack/ontology-spec/meta";
import { and, inArray, field, evaluateQuery } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import { backendQueryReader } from "./query.js";
import { compileObjectSubset } from "./subset.js";
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
    objectTypeNames: string[];
    actionTypeNames: string[];
    queryFunctionTypeNames: string[];
}

/** Pull selected definitions directly from a metadata backend, without a replica or UI collections. */
export const pull = Effect.fn("Metadata.pull")(function* (
    backend: Pick<OntologyBackendService, "loadSubset">,
    options: PullOptions
) {
    const reader = backendQueryReader(metaOntology, backend);
    const load = Effect.fnUntraced(function* <A>(
        objectType: string,
        query: Parameters<typeof reader.loadSubset>[1]
    ) {
        return (yield* reader.loadSubset(objectType, query)).map((row) => row.value as A);
    });
    const { objectTypeNames, actionTypeNames, queryFunctionTypeNames } = options;
    const [objectTypes, descriptors, linkTypes, actionTypes, queryFunctionTypes] = yield* Effect.all(
        [
            load<ObjectType>("ObjectType", { where: inArray(field("name"), objectTypeNames) }),
            load<OntologyDescriptor>("Ontology", {
                orderBy: [{ field: field("id"), direction: "asc" }],
                limit: 2,
            }),
            load<OntologyIR["linkTypes"][number]>("LinkType", {
                where: and(
                    inArray(field("source", "objectType"), objectTypeNames),
                    inArray(field("target", "objectType"), objectTypeNames)
                ),
            }),
            load<ActionType>("ActionType", { where: inArray(field("name"), actionTypeNames) }),
            load<QueryFunctionType>("QueryFunctionType", {
                where: inArray(field("name"), queryFunctionTypeNames),
            }),
        ],
        { concurrency: "unbounded" }
    );
    const invalid = (message: string) =>
        new BackendError({ operation: "metadata.pull", kind: "InvalidResponse", retryable: false, message });
    if (descriptors.length !== 1 || descriptors[0]?.id !== "ontology")
        return yield* invalid("Metadata must expose exactly one Ontology descriptor with id ontology.");
    const descriptor = descriptors[0];

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

    const result: OntologyIR = {
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
    const valid = validate(result);
    if (valid.kind === "err")
        return yield* invalid(
            `Pulled ontology is incomplete or invalid: ${valid.value.map((issue) => issue.message).join(" ")}`
        );
    return result;
});

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

    return {
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
    };
}
