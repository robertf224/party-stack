import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryCollectionUtils } from "@tanstack/query-db-collection";
import type { Collection } from "@tanstack/db";
import { createLiveOntology } from "@party-stack/ontology";
import type {
    LiveOntology,
    OntologyDefinition,
    OntologyAdapter,
    OntologyCollectionOptions,
    OntologyIR,
} from "@party-stack/ontology";
import type { BlobStoreProvider } from "@party-stack/blobs";
import { serializeLoadSubsetOptions, type RemoteOntologyTransport } from "./protocol.js";

export interface CreateRemoteOntologyAdapterOptions {
    ir: OntologyIR;
    transport: RemoteOntologyTransport;
}

export interface CreateRemoteLiveOntologyOptions {
    transport: RemoteOntologyTransport;
    id?: string;
    blobStore?: BlobStoreProvider;
}

function getObjectTypePrimaryKey(ir: OntologyIR, objectType: string): string {
    const objectTypeDef = ir.objectTypes.find((candidate) => candidate.name === objectType);
    if (!objectTypeDef) {
        throw new Error(`Unknown ontology object type "${objectType}".`);
    }
    return objectTypeDef.primaryKey;
}

export function createRemoteOntologyAdapter(opts: CreateRemoteOntologyAdapterOptions): OntologyAdapter {
    const { transport } = opts;
    const queryClient = new QueryClient();
    const queryKeyPrefix = ["remote-ontology", "remote"];

    return {
        name: "remote",
        getCollectionOptions: (objectType: string) => {
            const primaryKey = getObjectTypePrimaryKey(opts.ir, objectType);

            return queryCollectionOptions<Record<string, unknown>>({
                queryClient,
                getKey: (row) => row[primaryKey] as string | number,
                queryKey: [...queryKeyPrefix, objectType],
                syncMode: "on-demand",
                queryFn: async (ctx) => {
                    const response = await transport.loadSubset(
                        {
                            objectType,
                            options: serializeLoadSubsetOptions(ctx.meta?.loadSubsetOptions),
                        },
                        { signal: ctx.signal }
                    );
                    return response.objects;
                },
            }) as unknown as OntologyCollectionOptions;
        },
        applyAction: async (actionType, parameters, live) => {
            const response = await transport.applyAction({
                actionType,
                parameters,
            }, {
                attachments: live.attachmentUploads,
            });

            const invalidatedObjectTypes =
                response.invalidatedObjectTypes && response.invalidatedObjectTypes.length > 0
                    ? response.invalidatedObjectTypes
                    : opts.ir.objectTypes.map((objectType) => objectType.name);

            await Promise.all(
                invalidatedObjectTypes.map((objectType) => {
                    const collection = live.objects[objectType] as Collection<
                        Record<string, unknown>,
                        string | number,
                        QueryCollectionUtils<Record<string, unknown>>
                    >;
                    return collection.utils.refetch({ throwOnError: true });
                })
            );
            return {
                attachmentIdMappings: response.attachmentIdMappings,
            };
        },
        runQueryFunction: async (queryFunctionType, parameters) => {
            const response = await transport.runQueryFunction({
                queryFunctionType,
                parameters,
            });
            return response.value;
        },
        attachments: {
            generateAttachmentId: () => crypto.randomUUID(),
            getAttachmentContent: (attachment) => transport.getAttachmentContent({ attachment }),
            getAttachmentMetadata: (attachment) => transport.getAttachmentMetadata({ attachment }),
        },
    };
}

export async function createRemoteLiveOntology<
    Ontology extends OntologyDefinition = OntologyDefinition,
>(opts: CreateRemoteLiveOntologyOptions): Promise<LiveOntology<Ontology>> {
    const description = await opts.transport.describe();
    const adapter = createRemoteOntologyAdapter({
        ir: description.ir,
        transport: opts.transport,
    });
    return createLiveOntology<Ontology>({
        ir: description.ir,
        adapter,
        id: opts.id,
        blobStore: opts.blobStore,
        getContext: () => description.context ?? {},
    });
}
