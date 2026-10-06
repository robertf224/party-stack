import {
    createPersistedCollectionCoordinator,
    type RuntimeAdapter,
} from "@party-stack/runtime";
import { BasicIndex, createCollection, type Collection } from "@tanstack/db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import { decorateObjectAttachmentSources } from "../attachments/attachmentSources.js";
import { ontologyObjectCollectionId } from "./ontologyObjectCollectionId.js";
import type { OntologyIR } from "../../ir/index.js";
import type { OntologyBackendAdapter } from "../OntologyBackendAdapter.js";
import type { OntologyObject } from "./OntologyObject.js";

export type OntologyCollection<T extends OntologyObject> = Collection<T>;

function decorateCollectionSync(opts: {
    ir: OntologyIR;
    objectType: OntologyIR["objectTypes"][number];
    collectionOptions: ReturnType<OntologyBackendAdapter["getCollectionOptions"]>;
}): ReturnType<OntologyBackendAdapter["getCollectionOptions"]> {
    return {
        ...opts.collectionOptions,
        sync: {
            ...opts.collectionOptions.sync,
            sync: (syncParams) =>
                opts.collectionOptions.sync.sync({
                    ...syncParams,
                    write: (message) => {
                        if (message.type === "delete") {
                            syncParams.write(message);
                            return;
                        }
                        syncParams.write({
                            ...message,
                            value: decorateObjectAttachmentSources({
                                ir: opts.ir,
                                objectType: opts.objectType,
                                object: message.value,
                            }),
                        });
                    },
                }),
        },
    };
}

export function createLiveOntologyObjectCollection(opts: {
    ir: OntologyIR;
    objectType: OntologyIR["objectTypes"][number];
    backendAdapter: OntologyBackendAdapter;
    runtime: RuntimeAdapter;
    persistObjects: boolean;
}): OntologyCollection<OntologyObject> {
    const collectionOptions = decorateCollectionSync({
        ir: opts.ir,
        objectType: opts.objectType,
        collectionOptions: opts.backendAdapter.getCollectionOptions(opts.objectType.name),
    });
    const options = {
        ...collectionOptions,
        id: ontologyObjectCollectionId(
            opts.runtime.owner,
            opts.runtime.namespace,
            opts.objectType.name
        ),
        defaultIndexType: BasicIndex,
        autoIndex: "eager" as const,
        getKey: (object: OntologyObject) =>
            (object as Record<string, string | number>)[opts.objectType.primaryKey] as string | number,
    };
    if (!opts.persistObjects) {
        return createCollection(options) as OntologyCollection<OntologyObject>;
    }
    if (!opts.runtime.persistence) {
        throw new Error(
            `Live ontology object persistence requires a runtime persistence adapter (${opts.objectType.name}).`
        );
    }

    return createCollection(
        persistedCollectionOptions<
            OntologyObject,
            string | number
        >({
            ...options,
            schemaVersion: 1,
            persistence: {
                adapter: opts.runtime.persistence,
                coordinator:
                    createPersistedCollectionCoordinator(
                        opts.runtime.coordination,
                        opts.runtime.persistence
                    ),
            },
        })
    ) as OntologyCollection<OntologyObject>;
}
