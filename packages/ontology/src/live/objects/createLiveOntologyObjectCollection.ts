import { BasicIndex, createCollection, type Collection } from "@tanstack/db";
import { decorateObjectAttachmentSources } from "../attachments/attachmentSources.js";
import { ontologyObjectCollectionId } from "./ontologyObjectCollectionId.js";
import type { OntologyObject } from "./OntologyObject.js";
import type { OntologyIR } from "../../ir/index.js";
import type { OntologyAdapter } from "../OntologyAdapter.js";

export type OntologyCollection<T extends OntologyObject> = Collection<T>;

function decorateCollectionSync(opts: {
    ir: OntologyIR;
    objectType: OntologyIR["objectTypes"][number];
    collectionOptions: ReturnType<OntologyAdapter["getCollectionOptions"]>;
}): ReturnType<OntologyAdapter["getCollectionOptions"]> {
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
    ontologyId: string;
    ir: OntologyIR;
    objectType: OntologyIR["objectTypes"][number];
    adapter: OntologyAdapter;
}): OntologyCollection<OntologyObject> {
    const collectionOptions = decorateCollectionSync({
        ir: opts.ir,
        objectType: opts.objectType,
        collectionOptions: opts.adapter.getCollectionOptions(opts.objectType.name),
    });

    return createCollection({
        ...collectionOptions,
        id: ontologyObjectCollectionId(opts.ontologyId, opts.objectType.name),
        defaultIndexType: BasicIndex,
        autoIndex: "eager",
        getKey: (object) =>
            (object as Record<string, string | number>)[opts.objectType.primaryKey] as string | number,
    }) as OntologyCollection<OntologyObject>;
}
