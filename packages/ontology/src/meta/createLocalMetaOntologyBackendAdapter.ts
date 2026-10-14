import { localOnlyCollectionOptions } from "@tanstack/db";
import type { OntologyIR } from "../ir/index.js";
import type { OntologyBackendAdapter, OntologyCollectionOptions } from "../live/OntologyBackendAdapter.js";
import type { ActionType, ObjectType } from "./generated/types.js";

function localId(kind: "ActionType" | "ObjectType" | "Property", name: string): string {
    return `local:${kind}:${encodeURIComponent(name)}`;
}

function collectionOptions<T extends object>(
    rows: T[],
    getKey: (row: T) => string
): OntologyCollectionOptions {
    return localOnlyCollectionOptions({
        getKey,
        initialData: rows,
    }) as unknown as OntologyCollectionOptions;
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
        getCollectionOptions(objectType) {
            switch (objectType) {
                case "ObjectType":
                    return collectionOptions(objectTypes, (row) => row.name);
                case "ValueType":
                    return collectionOptions(ir.types, (row) => row.name);
                case "LinkType":
                    return collectionOptions(ir.linkTypes, (row) => row.id);
                case "ActionType":
                    return collectionOptions(actionTypes, (row) => row.name);
                case "QueryFunctionType":
                    return collectionOptions(ir.queryFunctionTypes, (row) => row.name);
                default:
                    throw new Error(`Unsupported local metadata object type "${objectType}".`);
            }
        },
        applyAction: () => Promise.reject(new Error("Local metadata is read-only.")),
        runQueryFunction: () => Promise.reject(new Error("Local metadata has no query functions.")),
    };
}
