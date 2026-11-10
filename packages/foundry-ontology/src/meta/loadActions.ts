import {
    ActionTypesFullMetadata,
    type ActionTypeFullMetadata,
    type ActionTypeV2,
} from "@osdk/foundry.ontologies";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import type { OntologyClient } from "@party-stack/foundry-client";

// These 404 for some reason on full metadata calls right now but we don't need them right now.
export function isNotDeclarativeActionType(actionType: ActionTypeV2): boolean {
    return actionType.operations.length === 0;
}

export async function loadActionTypesFullMetadata(
    client: OntologyClient,
    actionTypes: ActionTypeV2[]
): Promise<ActionTypeFullMetadata[]> {
    const declarativeActionTypes = actionTypes.filter(
        (actionType) => !isNotDeclarativeActionType(actionType)
    );
    const fullMetadataByApiName = new Map<string, ActionTypeFullMetadata>();
    const fullMetadata = await AsyncIterable.toArray(
        AsyncIterable.fromBatches(
            declarativeActionTypes,
            async (batch) =>
                (
                    await ActionTypesFullMetadata.getFullMetadataBatch(
                        client,
                        client.ontologyRid,
                        {
                            requests: batch.map((actionType) => ({
                                actionType: actionType.apiName,
                            })),
                        },
                        { preview: true }
                    )
                ).data,
            100
        )
    );
    for (const metadata of fullMetadata) {
        fullMetadataByApiName.set(metadata.actionType.apiName, metadata);
    }

    return actionTypes.map(
        (actionType) =>
            fullMetadataByApiName.get(actionType.apiName) ?? {
                actionType,
                fullLogicRules: [],
            }
    );
}
