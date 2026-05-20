import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type {
    OntologyAdapter,
    OntologyCollectionOptions,
    OntologyIR,
} from "@party-stack/ontology";
import {
    createHttpRemoteOntologyTransport,
    serializeLoadSubsetOptions,
    type RemoteOntologyTransport,
} from "./index.js";

export interface CreateRemoteOntologyAdapterOptions {
    ir: OntologyIR;
    transport?: RemoteOntologyTransport;
    url?: string | URL;
    fetch?: typeof fetch;
    headers?: HeadersInit | (() => HeadersInit);
    queryClient?: QueryClient;
    version?: string;
    name?: string;
}

function getObjectTypePrimaryKey(ir: OntologyIR, objectType: string): string {
    const objectTypeDef = ir.objectTypes.find((candidate) => candidate.name === objectType);
    if (!objectTypeDef) {
        throw new Error(`Unknown ontology object type "${objectType}".`);
    }
    return objectTypeDef.primaryKey;
}

export function createRemoteOntologyAdapter(opts: CreateRemoteOntologyAdapterOptions): OntologyAdapter {
    const transport =
        opts.transport ??
        (opts.url
            ? createHttpRemoteOntologyTransport({ url: opts.url, fetch: opts.fetch, headers: opts.headers })
            : undefined);
    if (!transport) {
        throw new Error("createRemoteOntologyAdapter requires either a transport or url.");
    }

    const queryClient = opts.queryClient ?? new QueryClient();
    const queryKeyPrefix = ["remote-ontology", opts.name ?? "default"];

    return {
        name: opts.name ?? "remote",
        getCollectionOptions: (objectType: string) => {
            const primaryKey = getObjectTypePrimaryKey(opts.ir, objectType);

            return queryCollectionOptions<Record<string, unknown>>({
                queryClient,
                getKey: (row) => row[primaryKey] as string | number,
                queryKey: [...queryKeyPrefix, objectType],
                syncMode: "on-demand",
                queryFn: async (ctx) => {
                    const response = await transport.loadSubset({
                        objectType,
                        ontologyVersion: opts.version,
                        options: serializeLoadSubsetOptions(ctx.meta?.loadSubsetOptions),
                    });
                    return response.objects;
                },
            }) as unknown as OntologyCollectionOptions;
        },
        applyAction: async (actionType, parameters) => {
            const response = await transport.applyAction({
                actionType,
                parameters,
                ontologyVersion: opts.version,
            });

            const invalidatedObjectTypes =
                response.invalidatedObjectTypes && response.invalidatedObjectTypes.length > 0
                    ? response.invalidatedObjectTypes
                    : opts.ir.objectTypes.map((objectType) => objectType.name);

            await Promise.all(
                invalidatedObjectTypes.map((objectType) =>
                    queryClient.invalidateQueries({
                        queryKey: [...queryKeyPrefix, objectType],
                    })
                )
            );
        },
    };
}
