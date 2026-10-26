import { BackendError } from "@party-stack/ontology-backend";
import metaOntology from "@party-stack/ontology-spec/meta";
import { evaluateQuery } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import type { OntologyBackendAdapter } from "../live/OntologyBackendAdapter.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { ActionType, ObjectType } from "@party-stack/ontology-spec/meta";

function localId(kind: "ActionType" | "ObjectType" | "Property", name: string): string {
    return `local:${kind}:${encodeURIComponent(name)}`;
}

export function createLocalMetaOntologyBackendAdapter(ir: OntologyIR): OntologyBackendAdapter {
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
        open: () =>
            Effect.succeed({
                name: "local-metadata",
                sourceId: "local-metadata",
                supportsIdempotency: false,
                loadSubset: (subset) =>
                    Effect.suspend(() => {
                        const rows: Record<string, readonly object[]> = {
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
                                    kind: "ValidationFailed",
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
                    }),
                invoke: () =>
                    Effect.fail(
                        new BackendError({
                            operation: "invoke",
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
            }),
    };
}
