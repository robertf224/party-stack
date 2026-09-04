import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryCollectionUtils } from "@tanstack/query-db-collection";
import type { Collection } from "@tanstack/db";
import { createLiveOntology } from "@party-stack/ontology";
import type {
    CreateLiveOntologyOpts,
    LiveOntology,
    OntologyDefinition,
    OntologyBackendAdapter,
    OntologyBackendAdapterProvider,
    OntologyCollectionOptions,
    OntologyIR,
    OntologyApplyActionResult,
    Uncertain,
} from "@party-stack/ontology";
import type { Result } from "@party-stack/ontology/values";
import { serializeLoadSubsetOptions, type RemoteOntologyTransport } from "./protocol.js";

export interface OntologyApplyActionClientResult extends OntologyApplyActionResult {
    invalidatedObjectTypes?: string[];
}

export interface CreateRemoteOntologyBackendAdapterOptions {
    ir: OntologyIR;
    transport: RemoteOntologyTransport;
}

export type CreateRemoteOntologyBackendOptions<
    Context extends Record<string, unknown> = Record<string, unknown>,
> =
    | {
          transport: RemoteOntologyTransport;
      }
    | {
          createTransport: (
              ir: OntologyIR,
              context: Context
          ) => RemoteOntologyTransport | Promise<RemoteOntologyTransport>;
      };

export interface CreateRemoteLiveOntologyOptions<
    Context extends Record<string, unknown> = Record<string, unknown>,
> {
    transport: RemoteOntologyTransport;
    id?: string;
    runtime?: CreateLiveOntologyOpts<Context>["runtime"];
    persistObjects?: CreateLiveOntologyOpts<Context>["persistObjects"];
    writes?: CreateLiveOntologyOpts<Context>["writes"];
}

function getObjectTypePrimaryKey(ir: OntologyIR, objectType: string): string {
    const objectTypeDef = ir.objectTypes.find((candidate) => candidate.name === objectType);
    if (!objectTypeDef) {
        throw new Error(`Unknown ontology object type "${objectType}".`);
    }
    return objectTypeDef.primaryKey;
}

async function refreshInvalidatedCollections(opts: {
    objectTypes: string[];
    objects: Record<string, Collection<Record<string, unknown>>>;
}): Promise<void> {
    await Promise.all(
        opts.objectTypes.map(async (objectType) => {
            const collection = opts.objects[objectType] as
                | Collection<Record<string, unknown>, string | number, QueryCollectionUtils<Record<string, unknown>>>
                | undefined;
            if (!collection?.utils?.refetch) {
                return;
            }
            try {
                await collection.utils.refetch({ throwOnError: true });
            } catch {
                // The remote action is already confirmed. Refresh remains
                // best-effort and must not turn it into a failed write.
            }
        })
    );
}

function fromRemoteActionValidation(
    validation: Uncertain<Result<null, string[]>>
): Uncertain<Result<void, string[]>> {
    if (!validation.certain) {
        return validation;
    }
    if (validation.value.kind === "err") {
        return {
            certain: true,
            value: {
                kind: "err",
                value: validation.value.value,
            },
        };
    }
    return {
        certain: true,
        value: {
            kind: "ok",
            value: undefined,
        },
    };
}

export function createRemoteOntologyBackendAdapter(
    opts: CreateRemoteOntologyBackendAdapterOptions
): OntologyBackendAdapter {
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
            const response = await transport.applyAction(
                {
                    actionType,
                    parameters,
                    idempotencyKey: live.idempotencyKey,
                },
                {
                    attachments: live.attachmentUploads,
                }
            );

            const invalidatedObjectTypes =
                response.invalidatedObjectTypes && response.invalidatedObjectTypes.length > 0
                    ? response.invalidatedObjectTypes
                    : opts.ir.objectTypes.map((objectType) => objectType.name);

            // A confirmed remote write remains successful even when its
            // best-effort local cache refresh fails or is aborted.
            await refreshInvalidatedCollections({
                objectTypes: invalidatedObjectTypes,
                objects: live.objects,
            });

            const result: OntologyApplyActionClientResult = {
                attachmentIdMappings: response.attachmentIdMappings,
                invalidatedObjectTypes,
            };
            return result;
        },
        validateAction: async (actionType, parameters) => {
            return fromRemoteActionValidation(
                await transport.validateAction({
                    actionType,
                    parameters,
                })
            );
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
            getAttachmentMetadata: (attachment, selection) =>
                transport.getAttachmentMetadata({ attachment, selection }),
        },
        cleanup: () => queryClient.clear(),
    };
}

export function createRemoteOntologyBackend<
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateRemoteOntologyBackendOptions<Context>): OntologyBackendAdapterProvider<Context> {
    return async (ir, context) =>
        createRemoteOntologyBackendAdapter({
            ir,
            transport: "transport" in opts ? opts.transport : await opts.createTransport(ir, context),
        });
}

export async function createRemoteLiveOntology<
    Ontology extends OntologyDefinition = OntologyDefinition,
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateRemoteLiveOntologyOptions<Context>): Promise<LiveOntology<Ontology>> {
    const description = await opts.transport.describe();
    const backend = createRemoteOntologyBackend<Context>({
        transport: opts.transport,
    });
    return createLiveOntology<Ontology, Context>({
        ir: description.ir,
        backend,
        id: opts.id,
        runtime: opts.runtime,
        persistObjects: opts.persistObjects,
        writes: opts.writes,
        context: (description.context ?? {}) as Context,
    });
}
