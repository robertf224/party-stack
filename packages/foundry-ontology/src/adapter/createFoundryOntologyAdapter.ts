import { Actions } from "@osdk/foundry.ontologies";
import { Collection, NonRetriableError } from "@tanstack/db";
import { Temporal } from "temporal-polyfill";
import type { OntologyAdapter, OntologyIR } from "@party-stack/ontology";
import { getFoundryActionOverrideParameterMapping } from "../meta/convertMetaActionType.js";
import { toFoundryActionTypeName } from "../utils/actionTypeName.js";
import { OntologyClient } from "../utils/client.js";
import { createFoundryCodec } from "./foundryCodec.js";
import { objectCollectionOptions, type ObjectCollectionUtils } from "./objectCollectionOptions.js";

type FoundryObject = Record<string, unknown>;

type CollectionWithUtils = Collection<Record<string, unknown>, string | number, ObjectCollectionUtils>;
type ApplyActionResult = Awaited<ReturnType<typeof Actions.applyWithOverrides>> & {
    operationId?: string;
};

function serializeOverrideValue(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (value instanceof Temporal.Instant) {
        return value.toString();
    }
    if (value instanceof Temporal.PlainDate || value instanceof Temporal.PlainDateTime) {
        return value.toString();
    }
    return JSON.stringify(value) ?? "";
}

function getApplyActionOperationId(result: ApplyActionResult): string {
    const operationId = result.operationId;
    if (typeof operationId !== "string" || operationId.length === 0) {
        throw new Error("Foundry apply action response did not include an operationId.");
    }
    return operationId;
}

function getEditedObjectTypes(
    edits: Awaited<ReturnType<typeof Actions.applyWithOverrides>>["edits"]
): Set<string> {
    const objectTypes = new Set<string>();
    if (!edits || edits.type !== "edits") {
        return objectTypes;
    }

    for (const edit of edits.edits) {
        if (edit.type === "addObject" || edit.type === "modifyObject" || edit.type === "deleteObject") {
            objectTypes.add(edit.objectType);
        }
    }

    return objectTypes;
}

export function createFoundryOntologyAdapter(opts: {
    client: OntologyClient;
    ir: OntologyIR;
}): OntologyAdapter {
    const codec = createFoundryCodec(opts.ir);

    return {
        name: "foundry",
        getCollectionOptions: (objectType: string) => {
            const objectTypeDef = opts.ir.objectTypes.find((ot) => ot.name === objectType)!;
            return objectCollectionOptions({
                client: opts.client,
                objectType,
                primaryKeyProperty: objectTypeDef.primaryKey,
                decodeObject: (object) => codec.decodeObject(objectType, object) as FoundryObject,
            });
        },
        applyAction: async (name, parameters, context) => {
            const actionType = opts.ir.actionTypes.find((actionType) => actionType.name === name)!;
            const overrideMapping = getFoundryActionOverrideParameterMapping(actionType);
            const parameterTypes = new Map(actionType.parameters.map((p) => [p.name, p.type]));
            const requestParameters: Record<string, unknown> = {};
            const uniqueIdentifierLinkIdValues: Record<string, string> = {};
            let actionExecutionTime: string | undefined;

            for (const [parameterName, value] of Object.entries(parameters)) {
                if (overrideMapping.uuidByParameterName.has(parameterName)) {
                    if (value !== undefined) {
                        uniqueIdentifierLinkIdValues[
                            overrideMapping.uuidByParameterName.get(parameterName)!
                        ] = serializeOverrideValue(value);
                    }
                    continue;
                }
                if (overrideMapping.nowParameterName === parameterName) {
                    if (value !== undefined) {
                        actionExecutionTime = serializeOverrideValue(value);
                    }
                    continue;
                }
                if (value !== undefined) {
                    const paramType = parameterTypes.get(parameterName);
                    requestParameters[parameterName] = paramType
                        ? codec.encodeValue(paramType, value)
                        : value;
                }
            }

            const result: ApplyActionResult = await Actions.applyWithOverrides(
                opts.client,
                opts.client.ontologyRid,
                toFoundryActionTypeName(name),
                {
                    request: {
                        options: {
                            mode: "VALIDATE_AND_EXECUTE",
                            returnEdits: "ALL_V2_WITH_DELETIONS",
                        },
                        parameters: requestParameters,
                    },
                    overrides: {
                        uniqueIdentifierLinkIdValues,
                        actionExecutionTime,
                    },
                },
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                {
                    preview: true,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any
            );
            if (result.validation?.result === "INVALID") {
                throw new NonRetriableError("Invalid Action arguments.");
            }
            if (context) {
                const operationId = getApplyActionOperationId(result);
                const targetCollections = Array.from(getEditedObjectTypes(result.edits))
                    .map((objectType) => context.objects[objectType] as CollectionWithUtils | undefined)
                    .filter((collection): collection is CollectionWithUtils =>
                        Boolean(collection?.utils?.awaitOperationId)
                    );

                await Promise.all(
                    targetCollections.map((collection) => collection.utils.awaitOperationId(operationId))
                );
            }
        },
    };
}
