import type { BlobManager } from "@party-stack/blobs";
import { resolveActionParameters } from "../expression.js";
import { applyActionLogic } from "./applyActionLogic.js";
import { prepareActionParameters } from "./prepareActionParameters.js";
import type { OntologyIR } from "../../ir/index.js";
import type { OntologyCollection } from "../objects/createLiveOntologyObjectCollection.js";
import type { OntologyObject } from "../objects/OntologyObject.js";
import type { OntologyAdapter, OntologyApplyActionResult } from "../OntologyAdapter.js";
import type { Collection } from "@tanstack/db";

export interface LiveOntologyActionExecution {
    mutationFn: () => Promise<OntologyApplyActionResult | void>;
    mutator: () => void;
}

export type LiveOntologyAction<Parameters extends Record<string, unknown> = Record<string, unknown>> = (
    parameters: Parameters
) => LiveOntologyActionExecution;

export function createLiveOntologyAction(opts: {
    ir: OntologyIR;
    action: OntologyIR["actionTypes"][number];
    adapter: OntologyAdapter;
    context?: Record<string, unknown>;
    objects: Record<string, OntologyCollection<OntologyObject>>;
    blobManager: BlobManager;
}): LiveOntologyAction {
    return (providedParameters: Record<string, unknown>) => {
        const context = opts.context ?? {};
        const parameters = resolveActionParameters(
            opts.ir,
            opts.action.name,
            providedParameters,
            context,
            opts.objects
        );

        return {
            mutationFn: async () => {
                const preparedAction = await prepareActionParameters({
                    ir: opts.ir,
                    actionTypeName: opts.action.name,
                    parameters,
                    adapter: opts.adapter,
                    blobManager: opts.blobManager,
                });
                const result = await opts.adapter.applyAction(
                    opts.action.name,
                    preparedAction.parameters,
                    {
                        objects: opts.objects as Record<string, Collection<Record<string, unknown>>>,
                        context,
                        attachmentUploads: preparedAction.attachmentUploads,
                    }
                );
                await Promise.all(
                    (result?.attachmentIdMappings ?? []).map((mapping) =>
                        opts.blobManager.markUploaded(mapping.localId, {
                            remoteId: mapping.remoteId,
                        })
                    )
                );
                return result;
            },
            mutator: () => {
                applyActionLogic({
                    ir: opts.ir,
                    actionTypeName: opts.action.name,
                    parameters,
                    context,
                    objects: opts.objects,
                });
            },
        };
    };
}
