import { CloudKitError } from "@party-stack/cloudkit-client";
import { createCloudKitActionWorkspace } from "./actionWorkspace.js";
import {
    cloudKitOntologySchemaFields,
    cloudKitRecordName,
    encodeCloudKitObject,
} from "./codec.js";
import { cloudKitObjectCollectionOptions } from "./objectCollectionOptions.js";
import {
    applyActionLogicToMutatorTx,
    createMutatorTx,
    type OntologyAttachmentsAdapter,
    type OntologyBackendAdapter,
    type OntologyBackendAdapterProvider,
    type OntologyIR,
    type OntologyMutatorTx,
    type OntologyObject,
    type OntologyPropertyChange,
} from "@party-stack/ontology";
import { createTransaction } from "@tanstack/db";
import type {
    CloudKitClient,
    CloudKitLocation,
    CloudKitModifyOperation,
    CloudKitRecord,
} from "@party-stack/cloudkit-client";

export {
    cloudKitObjectCollectionOptions,
    type CloudKitObjectCollectionOptions,
    type CloudKitObjectCollectionUtils,
} from "./objectCollectionOptions.js";
export {
    cloudKitOntologySchemaFields,
    cloudKitFieldNameForProperty,
    cloudKitPrimaryKeyFromRecordName,
    cloudKitRecordName,
    cloudKitRecordTypeForObjectType,
    cloudKitSchemaTypeForOntologyType,
    decodeCloudKitObject,
    encodeCloudKitObject,
} from "./codec.js";
export { generateCloudKitSchema } from "./schema.js";

const ATTACHMENT_RECORD_TYPE = "PS_PartyStackAttachment";
const ACTION_RECEIPT_RECORD_TYPE =
    "PS_PartyStackActionReceipt";

type PlannedMutation =
    | {
          kind: "create";
          objectType: string;
          object: Record<string, unknown>;
      }
    | {
          kind: "update";
          objectType: string;
          key: string | number;
          changes:
              | Record<string, unknown>
              | OntologyPropertyChange[];
      }
    | {
          kind: "delete";
          objectType: string;
          key: string | number;
      };

function attachmentRecordName(id: string): string {
    return `Attachment:${encodeURIComponent(id)}`;
}

function actionReceiptRecordName(id: string): string {
    return `Action:${encodeURIComponent(id)}`;
}

function getAttachmentName(value: unknown): string | undefined {
    if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value)
    ) {
        return undefined;
    }
    const name = (value as Record<string, unknown>).name;
    return typeof name === "string" ? name : undefined;
}

export interface CreateCloudKitOntologyBackendAdapterOptions {
    client: CloudKitClient;
    ir: OntologyIR;
    location?: CloudKitLocation;
    pollIntervalMs?: number;
    name?: string;
}

export function createCloudKitOntologyBackendAdapter(
    options: CreateCloudKitOntologyBackendAdapterOptions
): OntologyBackendAdapter {
    const location: CloudKitLocation =
        options.location ?? {
            databaseScope: "private",
            zone: { zoneName: "party-stack" },
        };
    const recordChangeTags = new Map<string, string>();
    const catchUps = new Map<string, () => Promise<void>>();
    const objectTypes = new Map(
        options.ir.objectTypes.map((objectType) => [
            objectType.name,
            objectType,
        ])
    );

    const registerCatchUp = (
        objectType: string,
        catchUp: () => Promise<void>
    ) => {
        catchUps.set(objectType, catchUp);
        return () => {
            if (catchUps.get(objectType) === catchUp) {
                catchUps.delete(objectType);
            }
        };
    };

    const catchUpAll = async () => {
        await Promise.all(
            [...catchUps.values()].map((catchUp) => catchUp())
        );
    };
    const getRecordChangeTag = async (
        recordName: string
    ): Promise<string | undefined> => {
        const cached = recordChangeTags.get(recordName);
        if (cached) return cached;
        const [record] = await options.client.fetchRecords({
            location,
            recordNames: [recordName],
        });
        if (record?.recordChangeTag) {
            recordChangeTags.set(
                recordName,
                record.recordChangeTag
            );
        }
        return record?.recordChangeTag;
    };

    const attachments: OntologyAttachmentsAdapter = {
        generateAttachmentId: () => crypto.randomUUID(),
        async getAttachmentContent(attachment) {
            const [record] = await options.client.fetchRecords({
                location,
                recordNames: [
                    attachmentRecordName(attachment.id),
                ],
            });
            const field =
                record?.fields[
                    cloudKitOntologySchemaFields.attachmentAsset
                ];
            if (!field || field.type !== "asset") {
                throw new CloudKitError(
                    "notFound",
                    `CloudKit attachment "${attachment.id}" was not found.`
                );
            }
            return options.client.downloadAsset(field.value);
        },
        async getAttachmentMetadata(attachment) {
            const [record] = await options.client.fetchRecords({
                location,
                recordNames: [
                    attachmentRecordName(attachment.id),
                ],
            });
            if (!record) {
                throw new CloudKitError(
                    "notFound",
                    `CloudKit attachment "${attachment.id}" was not found.`
                );
            }
            const fields = record.fields;
            const contentType =
                fields[
                    cloudKitOntologySchemaFields
                        .attachmentContentType
                ];
            const size =
                fields[
                    cloudKitOntologySchemaFields.attachmentSize
                ];
            const name =
                fields[
                    cloudKitOntologySchemaFields.attachmentName
                ];
            return {
                ...attachment,
                type:
                    contentType?.type === "string"
                        ? contentType.value
                        : "application/octet-stream",
                size:
                    size?.type === "int64"
                        ? Number(size.value)
                        : 0,
                name:
                    name?.type === "string"
                        ? name.value
                        : attachment.name,
            };
        },
    };

    return {
        name: options.name ?? "cloudkit",
        getCollectionOptions: (objectType) =>
            cloudKitObjectCollectionOptions({
                client: options.client,
                ir: options.ir,
                objectType,
                location,
                pollIntervalMs: options.pollIntervalMs,
                recordChangeTags,
                registerCatchUp,
            }),
        applyAction: async (
            actionTypeName,
            parameters,
            live
        ) => {
            const plannedMutations: PlannedMutation[] = [];
            const idempotencyKey =
                live.idempotencyKey ?? crypto.randomUUID();
            const receiptName =
                actionReceiptRecordName(idempotencyKey);
            await options.client.ensureZone(location);
            if (live.idempotencyKey) {
                const [existingReceipt] =
                    await options.client.fetchRecords({
                        location,
                        recordNames: [receiptName],
                    });
                if (existingReceipt) {
                    await catchUpAll();
                    return;
                }
            }
            const workspace =
                await createCloudKitActionWorkspace({
                    client: options.client,
                    ir: options.ir,
                    location,
                    actionTypeName,
                    parameters,
                });
            const collections = workspace.objects;
            try {
            const transaction = createTransaction<OntologyObject>({
                autoCommit: false,
                mutationFn: async () => {
                    const operationsByRecordName = new Map<
                        string,
                        CloudKitModifyOperation
                    >();
                    for (const edit of plannedMutations) {
                        const objectType = objectTypes.get(
                            edit.objectType
                        );
                        if (!objectType) {
                            throw new Error(
                                `Unknown object type "${edit.objectType}".`
                            );
                        }
                        const key =
                            edit.kind === "create"
                                ? edit.object[
                                      objectType.primaryKey
                                  ]
                                : edit.key;
                        if (
                            typeof key !== "string" &&
                            typeof key !== "number"
                        ) {
                            throw new Error(
                                `${edit.objectType} edit is missing primary key "${objectType.primaryKey}".`
                            );
                        }
                        const recordName = cloudKitRecordName(
                            edit.objectType,
                            key
                        );
                        const previous =
                            operationsByRecordName.get(recordName);
                        if (edit.kind === "delete") {
                            if (previous?.type === "create") {
                                operationsByRecordName.delete(
                                    recordName
                                );
                                continue;
                            }
                            const recordChangeTag =
                                await getRecordChangeTag(
                                    recordName
                                );
                            if (!recordChangeTag) {
                                // Deletes are idempotent. A missing remote
                                // record can remain in a persisted local cache
                                // after an earlier optimistic write failed.
                                // Committing the receipt without a delete
                                // operation lets this transaction remove that
                                // stale local row.
                                continue;
                            }
                            operationsByRecordName.set(recordName, {
                                type: "delete",
                                recordName,
                                recordChangeTag,
                            });
                            continue;
                        }

                        const object =
                            collections[edit.objectType]?.get(key) ??
                            (edit.kind === "create"
                                ? edit.object
                                : undefined);
                        if (!object) {
                            throw new Error(
                                `${edit.objectType} object "${String(key)}" is unavailable after its action edit.`
                            );
                        }
                        const isCreate =
                            edit.kind === "create" ||
                            previous?.type === "create";
                        const recordChangeTag = isCreate
                            ? undefined
                            : await getRecordChangeTag(
                                  recordName
                              );
                        if (!isCreate && !recordChangeTag) {
                            throw new CloudKitError(
                                "conflict",
                                `CloudKit change tag is unavailable for "${recordName}".`
                            );
                        }
                        const record = encodeCloudKitObject({
                            ir: options.ir,
                            objectType: edit.objectType,
                            primaryKey: objectType.primaryKey,
                            object,
                            zone: location.zone,
                            recordChangeTag,
                        });
                        operationsByRecordName.set(
                            recordName,
                            isCreate
                                ? { type: "create", record }
                                : {
                                      type: "replace",
                                      record: record as CloudKitRecord & {
                                          recordChangeTag: string;
                                      },
                                  }
                        );
                    }

                    const attachmentOperations =
                        await Promise.all(
                            (live.attachmentUploads ?? []).map(
                                async (upload) => {
                                    const asset =
                                        await options.client.uploadAsset({
                                            location,
                                            recordType:
                                                ATTACHMENT_RECORD_TYPE,
                                            fieldName:
                                                cloudKitOntologySchemaFields.attachmentAsset,
                                            blob: upload.blob,
                                        });
                                    const fields: CloudKitRecord["fields"] =
                                        {
                                            [cloudKitOntologySchemaFields.attachmentAsset]:
                                                {
                                                    type: "asset",
                                                    value: asset,
                                                },
                                            [cloudKitOntologySchemaFields.attachmentContentType]:
                                                {
                                                    type: "string",
                                                    value:
                                                        upload.blob.type ||
                                                        upload
                                                            .attachment
                                                            .type ||
                                                        "application/octet-stream",
                                                },
                                            [cloudKitOntologySchemaFields.attachmentSize]:
                                                {
                                                    type: "int64",
                                                    value: String(
                                                        upload.blob
                                                            .size
                                                    ),
                                                },
                                        };
                                    const name =
                                        getAttachmentName(
                                            upload.attachment
                                        );
                                    if (name) {
                                        fields[
                                            cloudKitOntologySchemaFields.attachmentName
                                        ] = {
                                            type: "string",
                                            value: name,
                                        };
                                    }
                                    return {
                                        type: "create" as const,
                                        record: {
                                            recordName:
                                                attachmentRecordName(
                                                    upload
                                                        .attachment
                                                        .id
                                                ),
                                            recordType:
                                                ATTACHMENT_RECORD_TYPE,
                                            fields,
                                        },
                                    };
                                }
                            )
                        );
                    const operations: CloudKitModifyOperation[] = [
                        ...operationsByRecordName.values(),
                        ...attachmentOperations,
                        {
                            type: "create",
                            record: {
                                recordName: receiptName,
                                recordType:
                                    ACTION_RECEIPT_RECORD_TYPE,
                                fields: {
                                    createdAt: {
                                        type: "date",
                                        value: new Date().toISOString(),
                                    },
                                },
                            },
                        },
                    ];
                    if (operations.length > 200) {
                        throw new Error(
                            `CloudKit actions support at most 199 record/attachment edits; received ${operations.length - 1}.`
                        );
                    }
                    try {
                        const result =
                            await options.client.modifyRecords({
                                location,
                                operations,
                                atomic: true,
                            });
                        for (const record of result.records) {
                            if (record.recordChangeTag) {
                                recordChangeTags.set(
                                    record.recordName,
                                    record.recordChangeTag
                                );
                            }
                        }
                    } catch (error) {
                        if (
                            error instanceof CloudKitError &&
                            error.code === "conflict"
                        ) {
                            const [receipt] =
                                await options.client.fetchRecords({
                                    location,
                                    recordNames: [receiptName],
                                });
                            if (receipt) return;
                        }
                        throw error;
                    }
                },
            });

            const baseTx = createMutatorTx({
                transaction,
                objects: collections,
                primaryKeys: Object.fromEntries(
                    options.ir.objectTypes.map((objectType) => [
                        objectType.name,
                        objectType.primaryKey,
                    ])
                ),
            });
            const tx: OntologyMutatorTx = {
                query: baseTx.query,
                mutate: new Proxy(
                    {},
                    {
                        get: (_target, objectType) => {
                            if (typeof objectType !== "string") {
                                return undefined;
                            }
                            const baseMutator =
                                baseTx.mutate[objectType];
                            if (!baseMutator) {
                                throw new Error(
                                    `Unknown object type "${objectType}".`
                                );
                            }
                            return {
                                create: async (
                                    object: Record<string, unknown>
                                ) => {
                                    await baseMutator.create(object);
                                    plannedMutations.push({
                                        kind: "create",
                                        objectType,
                                        object,
                                    });
                                },
                                update: async (
                                    key: string | number,
                                    changes:
                                        | Record<string, unknown>
                                        | OntologyPropertyChange[]
                                ) => {
                                    await baseMutator.update(
                                        key,
                                        changes
                                    );
                                    plannedMutations.push({
                                        kind: "update",
                                        objectType,
                                        key,
                                        changes,
                                    });
                                },
                                delete: async (
                                    key: string | number
                                ) => {
                                    await baseMutator.delete(key);
                                    plannedMutations.push({
                                        kind: "delete",
                                        objectType,
                                        key,
                                    });
                                },
                            };
                        },
                    }
                ) as OntologyMutatorTx["mutate"],
            };
            await applyActionLogicToMutatorTx({
                ir: options.ir,
                actionTypeName,
                parameters,
                context: live.context ?? {},
                objects: collections,
                tx,
            });
            await transaction.commit();
            } finally {
                await workspace.cleanup();
            }
            await catchUpAll();
        },
        runQueryFunction: (name) =>
            Promise.reject(
                new Error(
                    `CloudKit ontology adapter cannot run query function type "${name}".`
                )
            ),
        attachments,
    };
}

export interface CreateCloudKitOntologyBackendOptions<
    Context extends Record<string, unknown> = Record<
        string,
        unknown
    >,
> {
    location?: CloudKitLocation;
    pollIntervalMs?: number;
    name?: string;
    client?:
        | CloudKitClient
        | ((
              ir: OntologyIR,
              context: Context
          ) => CloudKitClient | Promise<CloudKitClient>);
}

export function createCloudKitOntologyBackend<
    Context extends Record<string, unknown> = Record<
        string,
        unknown
    >,
>(
    options: CreateCloudKitOntologyBackendOptions<Context> & {
        client:
            | CloudKitClient
            | ((
                  ir: OntologyIR,
                  context: Context
              ) => CloudKitClient | Promise<CloudKitClient>);
    }
): OntologyBackendAdapterProvider<Context> {
    return async (ir, context) =>
        createCloudKitOntologyBackendAdapter({
            ir,
            client:
                typeof options.client === "function"
                    ? await options.client(ir, context)
                    : options.client,
            location: options.location,
            pollIntervalMs: options.pollIntervalMs,
            name: options.name,
        });
}
