import { createTransaction, type Collection, type Transaction } from "@tanstack/db";
import type { BlobManager } from "@party-stack/blobs";
import type { ConnectionMonitor } from "@party-stack/connections";
import type { RuntimeAdapter } from "@party-stack/runtime";
import { runOptimisticAction } from "../mutators/runOptimisticAction.js";
import { createOntologyOutbox, type OutboxProjection } from "../outbox/createOntologyOutbox.js";
import { createLiveOntologyAction } from "./createLiveOntologyAction.js";
import { prepareActionParameters } from "./prepareActionParameters.js";
import type { LiveOntologyAction, LiveOntologyActionOptions } from "./createLiveOntologyAction.js";
import type { OntologyIR } from "../../ir/index.js";
import type { LiveOntologyWrites, LiveOntologyWriteVisibility } from "../LiveOntology.js";
import type { OntologyCollection } from "../objects/createLiveOntologyObjectCollection.js";
import type { OntologyObject } from "../objects/OntologyObject.js";
import type { OntologyApplyActionResult, OntologyBackendAdapter } from "../OntologyBackendAdapter.js";
import type { OntologyActionRequest, OntologyOutbox, OntologyOutboxEntry } from "../outbox/types.js";

export interface LiveOntologyActionsSubsystem {
    actions: Record<string, LiveOntologyAction>;
    outbox: OntologyOutbox;
}

export function createLiveOntologyActions(options: {
    ir: OntologyIR;
    backendAdapter: OntologyBackendAdapter;
    runtime: RuntimeAdapter;
    context: Record<string, unknown>;
    objects: Record<string, OntologyCollection<OntologyObject>>;
    blobManager: BlobManager;
    writes?: LiveOntologyWrites;
    connection?: ConnectionMonitor;
}): LiveOntologyActionsSubsystem {
    const defaultMode = options.writes?.defaultMode ?? "direct";
    const defaultVisibility = options.writes?.defaultVisibility ?? "confirmed";

    const executeRemote = async (
        request: OntologyActionRequest
    ): Promise<OntologyApplyActionResult | void> => {
        const prepared = await prepareActionParameters({
            ir: options.ir,
            actionTypeName: request.actionTypeName,
            parameters: request.parameters,
            backendAdapter: options.backendAdapter,
            blobManager: options.blobManager,
        });
        const result = await options.backendAdapter.applyAction(request.actionTypeName, prepared.parameters, {
            objects: options.objects as Record<string, Collection<Record<string, unknown>>>,
            context: options.context,
            attachmentUploads: prepared.attachmentUploads,
            idempotencyKey: request.idempotencyKey,
        });
        const backendMappings = result?.attachmentIdMappings ?? [];
        const attachmentIdMappings = [...prepared.attachmentIdMappings, ...backendMappings];
        await Promise.all(
            attachmentIdMappings.map((mapping) =>
                options.blobManager.bindRemoteId(mapping.localId, mapping.remoteId)
            )
        );
        return attachmentIdMappings.length > 0
            ? {
                  ...result,
                  attachmentIdMappings,
              }
            : result;
    };

    const applyOptimisticAction = async (
        transaction: Transaction,
        request: OntologyActionRequest
    ): Promise<boolean> => {
        try {
            await runOptimisticAction({
                transaction,
                ir: options.ir,
                actionTypeName: request.actionTypeName,
                parameters: request.parameters,
                context: options.context,
                objects: options.objects,
                mutators: options.writes?.mutators,
            });
        } catch (error) {
            if (transaction.state === "pending") {
                transaction.rollback();
            }
            throw error;
        }
        return transaction.mutations.length > 0;
    };

    const project = async (entry: OntologyOutboxEntry): Promise<OutboxProjection | undefined> => {
        const visibility = entry.visibility ?? defaultVisibility;
        if (visibility !== "optimistic") return;

        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const completion = new Promise<void>((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        const transaction = createTransaction({
            autoCommit: false,
            mutationFn: () => completion,
        });
        if (!(await applyOptimisticAction(transaction, entry.request))) {
            return;
        }
        void transaction.commit().catch(() => undefined);
        void transaction.isPersisted.promise.catch(() => undefined);
        return {
            settle(error) {
                if (error) reject(error);
                else resolve();
            },
        };
    };

    const outbox = createOntologyOutbox({
        runtime: options.runtime,
        execute: (entry) => executeRemote(entry.request),
        project,
        failureStrategy: options.writes?.outbox?.failureStrategy ?? "discard-all",
        maxRetries: options.writes?.outbox?.maxRetries,
        connection: options.connection,
    });

    const executeDirect = async (
        request: OntologyActionRequest,
        visibility: LiveOntologyWriteVisibility
    ): Promise<OntologyApplyActionResult | void> => {
        if (visibility === "confirmed") {
            return executeRemote(request);
        }

        let result: OntologyApplyActionResult | void = undefined;
        const transaction = createTransaction({
            autoCommit: false,
            mutationFn: async () => {
                result = await executeRemote(request);
            },
        });
        if (!(await applyOptimisticAction(transaction, request))) {
            return executeRemote(request);
        }
        await transaction.commit();
        return result;
    };

    const submit = async (
        request: OntologyActionRequest,
        actionOptions?: LiveOntologyActionOptions
    ): Promise<OntologyApplyActionResult | void> => {
        const mode = actionOptions?.mode ?? defaultMode;
        const visibility = actionOptions?.visibility ?? defaultVisibility;
        if (mode === "outbox") {
            const enqueued = await outbox.enqueue<OntologyApplyActionResult | void>(request, { visibility });
            return enqueued.completed;
        }
        return executeDirect(request, visibility);
    };

    const actions = Object.fromEntries(
        options.ir.actionTypes.map((action) => [
            action.name,
            createLiveOntologyAction({
                ir: options.ir,
                action,
                context: options.context,
                objects: options.objects,
                submit,
            }),
        ])
    );

    return {
        actions,
        outbox,
    };
}
