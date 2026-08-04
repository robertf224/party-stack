import {
    createCollection,
    localOnlyCollectionOptions,
} from "@tanstack/db";
import { resolveType, unwrapType } from "@party-stack/ontology/utils";
import {
    cloudKitRecordName,
    decodeCloudKitObject,
} from "./codec.js";
import type {
    CloudKitClient,
    CloudKitLocation,
} from "@party-stack/cloudkit-client";
import type {
    OntologyIR,
    OntologyObject,
} from "@party-stack/ontology";
import type { Collection } from "@tanstack/db";

export interface CloudKitActionWorkspace {
    objects: Record<string, Collection<OntologyObject>>;
    cleanup(): Promise<void>;
}

export async function createCloudKitActionWorkspace(options: {
    client: CloudKitClient;
    ir: OntologyIR;
    location: CloudKitLocation;
    actionTypeName: string;
    parameters: Record<string, unknown>;
}): Promise<CloudKitActionWorkspace> {
    const actionType = options.ir.actionTypes.find(
        (candidate) =>
            candidate.name === options.actionTypeName
    );
    if (!actionType) {
        throw new Error(
            `Unknown action type "${options.actionTypeName}".`
        );
    }

    const references = actionType.parameters.flatMap(
        (parameter) => {
            const { type } = unwrapType(
                resolveType(options.ir, parameter.type)
            );
            if (type.kind !== "objectReference") return [];
            const key = options.parameters[parameter.name];
            if (
                typeof key !== "string" &&
                typeof key !== "number"
            ) {
                return [];
            }
            return [
                {
                    objectType: type.value.objectType,
                    recordName: cloudKitRecordName(
                        type.value.objectType,
                        key
                    ),
                },
            ];
        }
    );
    const uniqueReferences = [
        ...new Map(
            references.map((reference) => [
                reference.recordName,
                reference,
            ])
        ).values(),
    ];
    const records =
        uniqueReferences.length === 0
            ? []
            : await options.client.fetchRecords({
                  location: options.location,
                  recordNames: uniqueReferences.map(
                      (reference) => reference.recordName
                  ),
              });
    const objectTypeByRecordName = new Map(
        uniqueReferences.map((reference) => [
            reference.recordName,
            reference.objectType,
        ])
    );
    const initialObjects = new Map<
        string,
        OntologyObject[]
    >();
    for (const record of records) {
        const objectType =
            objectTypeByRecordName.get(record.recordName);
        if (!objectType) continue;
        const object = decodeCloudKitObject({
            ir: options.ir,
            objectType,
            record,
        });
        const values = initialObjects.get(objectType) ?? [];
        values.push(object);
        initialObjects.set(objectType, values);
    }

    const workspaceId = crypto.randomUUID();
    const objects = Object.fromEntries(
        options.ir.objectTypes.map((objectType) => [
            objectType.name,
            createCollection(
                localOnlyCollectionOptions<
                    OntologyObject,
                    string | number
                >({
                    id: `cloudkit-action:${workspaceId}:${objectType.name}`,
                    getKey: (object) =>
                        object[
                            objectType.primaryKey
                        ] as string | number,
                    initialData:
                        initialObjects.get(objectType.name) ??
                        [],
                })
            ),
        ])
    );
    await Promise.all(
        Object.values(objects).map((collection) =>
            collection.preload()
        )
    );

    return {
        objects,
        async cleanup() {
            await Promise.all(
                Object.values(objects).map((collection) =>
                    collection.cleanup()
                )
            );
        },
    };
}
