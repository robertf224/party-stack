import { Actions } from "@osdk/foundry.ontologies";
import { Collection, NonRetriableError } from "@tanstack/db";
import { Temporal } from "temporal-polyfill";
import type { OntologyAdapter, OntologyIR } from "@party-stack/ontology";
import { getFoundryActionOverrideParameterMapping } from "../meta/convertMetaActionType.js";
import { toFoundryActionTypeName } from "../utils/actionTypeName.js";
import { OntologyClient } from "../utils/client.js";
import { createFoundryObjectDecoder } from "./foundryCodec.js";
import { objectCollectionOptions, type CollectionSyncEvent, type ObjectCollectionUtils } from "./objectCollectionOptions.js";

type FoundryObject = Record<string, unknown>;

type CollectionWithUtils = Collection<Record<string, unknown>, string | number, ObjectCollectionUtils>;

function serializeOverrideValue(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (value instanceof Temporal.Instant) {
        return value.toString();
    }
    if (value instanceof Temporal.PlainDate || value instanceof Temporal.PlainDateTime) {
        return value.toString();
    }
    return JSON.stringify(value) ?? "";
}

function snapshotSyncVersions(
    parameters: Record<string, unknown>,
    objectCollections: Record<string, Collection<Record<string, unknown>>>
): Map<string, number> {
    const snapshot = new Map<string, number>();
    const potentialKeys = Object.values(parameters).filter(
        (v): v is string | number => typeof v === "string" || typeof v === "number"
    );
    for (const [objectType, collection] of Object.entries(objectCollections)) {
        const coll = collection as CollectionWithUtils;
        if (!coll?.utils?.getObjectSyncVersion) continue;
        for (const key of potentialKeys) {
            snapshot.set(`${objectType}\0${key}`, coll.utils.getObjectSyncVersion(key));
        }
    }
    return snapshot;
}

function buildSyncTargets(opts: {
    edits: Exclude<Awaited<ReturnType<typeof Actions.applyWithOverrides>>["edits"], undefined>;
    objectCollections: Record<string, Collection<Record<string, unknown>>>;
    versionSnapshot: Map<string, number>;
}): Array<{
    collection: CollectionWithUtils;
    key: string | number;
    event: CollectionSyncEvent;
    afterVersion: number;
}> {
    if (opts.edits.type !== "edits") {
        return [];
    }

    const finalEventsByObjectType = new Map<string, Map<string | number, CollectionSyncEvent>>();
    for (const edit of opts.edits.edits) {
        if (edit.type !== "addObject" && edit.type !== "modifyObject" && edit.type !== "deleteObject") {
            continue;
        }

        const event: CollectionSyncEvent = edit.type === "deleteObject" ? "delete" : "upsert";
        const entries =
            finalEventsByObjectType.get(edit.objectType) ?? new Map<string | number, CollectionSyncEvent>();
        entries.set(edit.primaryKey as string | number, event);
        finalEventsByObjectType.set(edit.objectType, entries);
    }

    return Array.from(finalEventsByObjectType.entries()).flatMap(([objectType, entries]) => {
        const collection = opts.objectCollections[objectType] as CollectionWithUtils | undefined;
        if (!collection?.utils?.getObjectSyncVersion) {
            return [];
        }

        return Array.from(entries.entries()).map(([key, event]) => ({
            collection,
            key,
            event,
            afterVersion:
                opts.versionSnapshot.get(`${objectType}\0${key}`) ??
                collection.utils.getObjectSyncVersion(key),
        }));
    });
}

export function createFoundryOntologyAdapter(opts: {
    client: OntologyClient;
    ir: OntologyIR;
}): OntologyAdapter {
    const decoder = createFoundryObjectDecoder(opts.ir);

    return {
        name: "foundry",
        getCollectionOptions: (objectType: string) => {
            const objectTypeDef = opts.ir.objectTypes.find((ot) => ot.name === objectType)!;
            return objectCollectionOptions({
                client: opts.client,
                objectType,
                primaryKeyProperty: objectTypeDef.primaryKey,
                decodeObject: (object) => decoder.decodeObject(objectType, object) as FoundryObject,
            });
        },
        applyAction: async (name, parameters, context) => {
            const actionType = opts.ir.actionTypes.find((actionType) => actionType.name === name)!;
            const overrideMapping = getFoundryActionOverrideParameterMapping(actionType);
            const requestParameters: Record<string, unknown> = {};
            const uniqueIdentifierLinkIdValues: Record<string, string> = {};
            let actionExecutionTime: string | undefined;

            // Snapshot sync versions BEFORE the API call so the watcher can't
            // race ahead and bump the version before we capture it.
            const versionSnapshot = context
                ? snapshotSyncVersions(parameters, context.objects)
                : new Map<string, number>();

            for (const [parameterName, value] of Object.entries(parameters)) {
                if (overrideMapping.uuidByParameterName.has(parameterName)) {
                    if (value !== undefined) {
                        uniqueIdentifierLinkIdValues[
                            overrideMapping.uuidByParameterName.get(parameterName)!
                        ] = serializeOverrideValue(value);
                    }
                    continue;
                }
                if (overrideMapping.nowParameterName === parameterName) {
                    if (value !== undefined) {
                        actionExecutionTime = serializeOverrideValue(value);
                    }
                    continue;
                }
                if (value !== undefined) {
                    requestParameters[parameterName] = value;
                }
            }

            const result = await Actions.applyWithOverrides(
                opts.client,
                opts.client.ontologyRid,
                toFoundryActionTypeName(name),
                {
                    request: {
                        options: {
                            mode: "VALIDATE_AND_EXECUTE",
                            returnEdits: "ALL_V2_WITH_DELETIONS",
                        },
                        parameters: requestParameters,
                    },
                    overrides: {
                        uniqueIdentifierLinkIdValues,
                        actionExecutionTime,
                    },
                },
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                {
                    preview: true,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any
            );
            if (result.validation?.result === "INVALID") {
                throw new NonRetriableError("Invalid Action arguments.");
            }
            if (context && result.edits) {
                const targets = buildSyncTargets({
                    edits: result.edits,
                    objectCollections: context.objects,
                    versionSnapshot,
                });
                await Promise.all(
                    targets.map((t) =>
                        t.collection.utils.awaitObjectSync(t.key, {
                            event: t.event,
                            afterVersion: t.afterVersion,
                        })
                    )
                );
            }
        },
    };
}
