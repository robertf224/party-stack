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
} from "@party-stack/ontology";
import { serializeLoadSubsetOptions, type RemoteOntologyTransport } from "./protocol.js";

export interface OntologyActionRefreshResult {
    status: "ok" | "error" | "aborted";
    objectType: string;
    error?: {
        name: string;
        message: string;
    };
}

export interface OntologyActionRefreshDiagnostics {
    /**
     * Best-effort cache refresh after a confirmed remote write.
     * Never rejects; failures are reported in the resolved results.
     */
    completed: Promise<OntologyActionRefreshResult[]>;
}

export interface OntologyApplyActionClientResult extends OntologyApplyActionResult {
    invalidatedObjectTypes?: string[];
    refresh?: OntologyActionRefreshDiagnostics;
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
    getUserId?: CreateLiveOntologyOpts<Context>["getUserId"];
}

function getObjectTypePrimaryKey(ir: OntologyIR, objectType: string): string {
    const objectTypeDef = ir.objectTypes.find((candidate) => candidate.name === objectType);
    if (!objectTypeDef) {
        throw new Error(`Unknown ontology object type "${objectType}".`);
    }
    return objectTypeDef.primaryKey;
}

function toRefreshError(error: unknown): OntologyActionRefreshResult["error"] {
    if (error instanceof Error) {
        return { name: error.name, message: error.message };
    }
    return { name: "Error", message: String(error) };
}

function isAbortError(error: unknown): boolean {
    return (
        (error instanceof Error && error.name === "AbortError") ||
        (typeof DOMException !== "undefined" &&
            error instanceof DOMException &&
            error.name === "AbortError")
    );
}

async function refreshInvalidatedCollections(opts: {
    objectTypes: string[];
    objects: Record<string, Collection<Record<string, unknown>>>;
}): Promise<OntologyActionRefreshResult[]> {
    return Promise.all(
        opts.objectTypes.map(async (objectType): Promise<OntologyActionRefreshResult> => {
            const collection = opts.objects[objectType] as
                | Collection<Record<string, unknown>, string | number, QueryCollectionUtils<Record<string, unknown>>>
                | undefined;
            if (!collection?.utils?.refetch) {
                return { status: "ok", objectType };
            }
            try {
                await collection.utils.refetch({ throwOnError: true });
                return { status: "ok", objectType };
            } catch (error) {
                if (isAbortError(error)) {
                    return {
                        status: "aborted",
                        objectType,
                        error: toRefreshError(error),
                    };
                }
                return {
                    status: "error",
                    objectType,
                    error: toRefreshError(error),
                };
            }
        })
    );
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

            // Confirmed writes remain successful even when cache refresh fails
            // or is aborted by navigation. Refresh is best-effort and observable.
            const refreshCompleted = refreshInvalidatedCollections({
                objectTypes: invalidatedObjectTypes,
                objects: live.objects,
            });
            // Prevent unhandled rejections if callers never await diagnostics.
            void refreshCompleted.catch(() => undefined);

            const result: OntologyApplyActionClientResult = {
                attachmentIdMappings: response.attachmentIdMappings,
                invalidatedObjectTypes,
                refresh: {
                    completed: refreshCompleted,
                },
            };
            return result;
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
        getUserId: opts.getUserId,
    });
}
