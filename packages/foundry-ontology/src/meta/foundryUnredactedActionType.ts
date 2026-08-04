import { normalizeFoundryError, type OntologyClient } from "@party-stack/foundry-client";
import { getOntologyMetadataBulkLoadEntitiesUrl } from "./foundryPrivateApiUrls.js";

/**
 * Party-owned view of Foundry OMS unredacted action-type metadata.
 *
 * Generic `MetaActionType` (via the ActionType collection / `pull()`) already covers portable
 * declarative logic and public parameter types. Structures that only exist on the unredacted OMS
 * wire — layout, submission criteria, and nested parameter validations/prefills — are exposed
 * here as the explicit Foundry-specific escape hatch.
 */
export type FoundryActionStaticValue =
    | { type: "string"; string: string }
    | { type: "boolean"; boolean: boolean }
    | { type: "integer"; integer: number }
    | { type: "long"; long: number | string }
    | { type: "double"; double: number }
    | { type: "date"; date: string }
    | { type: "timestamp"; timestamp: string }
    | { type: "null" };

export type FoundryActionParameterPrefill =
    | { type: "staticValue"; staticValue: FoundryActionStaticValue }
    | {
          type: "objectParameterPropertyValue";
          objectParameterPropertyValue: {
              parameterId: string;
              propertyTypeId: string;
          };
      }
    | {
          type: "objectQueryPrefill";
          objectQueryPrefill: {
              objectSet: Record<string, unknown>;
          };
      }
    | { type: string; [key: string]: unknown };

export interface FoundryActionParameterValidationNode {
    /** Nested default validation block from OMS wire. */
    defaultValidation?: FoundryActionParameterValidationNode;
    validation?: {
        allowedValues?: unknown;
        defaultValue?: unknown;
        [key: string]: unknown;
    };
    display?: {
        prefill?: FoundryActionParameterPrefill | null;
        [key: string]: unknown;
    };
    prefill?: FoundryActionParameterPrefill | null;
    defaultValue?: unknown;
    structFieldValidations?: Record<string, FoundryActionParameterValidationNode>;
    [key: string]: unknown;
}

export interface FoundryUnredactedActionTypeMetadata {
    rid: string;
    /** Present when the OMS payload includes action metadata.apiName. */
    apiName?: string;
    parameterValidations: Record<string, FoundryActionParameterValidationNode>;
    /**
     * Remaining unredacted OMS `actionTypeLogic` payload (rules, submission criteria, etc.).
     * Intentionally opaque — Streamline interprets shapes it understands.
     */
    actionTypeLogic?: Record<string, unknown>;
    /** Remaining unredacted OMS `metadata` payload. */
    metadata?: Record<string, unknown>;
}

type BulkLoadActionTypeEntry = {
    actionType?: {
        rid?: string;
        metadata?: Record<string, unknown> & {
            rid?: string;
            apiName?: string;
        };
        actionTypeLogic?: Record<string, unknown> & {
            validation?: {
                parameterValidations?: Record<string, FoundryActionParameterValidationNode>;
            };
        };
    };
};

type BulkLoadOntologyEntitiesResponse = {
    actionTypes?: BulkLoadActionTypeEntry[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/**
 * Loads unredacted OMS action-type metadata by RID.
 *
 * Requires the `ontology:view-unredacted-action-type` scope. Uses OntologyClient's
 * `baseUrl` / `tokenProvider` / `fetch` only — no OSDK private context access.
 */
export async function getFoundryUnredactedActionTypeMetadata(
    client: OntologyClient,
    actionTypeRid: string
): Promise<FoundryUnredactedActionTypeMetadata | undefined> {
    const url = getOntologyMetadataBulkLoadEntitiesUrl(client.baseUrl);
    const token = await client.tokenProvider();

    let response: Response;
    try {
        response = await client.fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({
                actionTypes: [{ rid: actionTypeRid, versionReference: undefined }],
                datasourceTypes: [],
                linkTypes: [],
                objectTypes: [],
                sharedPropertyTypes: [],
                interfaceTypes: [],
                typeGroups: [],
            }),
        });
    } catch (error) {
        throw normalizeFoundryError(error);
    }

    if (response.status === 404) {
        return undefined;
    }

    if (!response.ok) {
        const body = await response.text().catch(() => undefined);
        throw normalizeFoundryError({
            statusCode: response.status,
            errorCode: "FOUNDRY_OMS_ERROR",
            errorName: "UnredactedActionTypeLoadFailed",
            errorInstanceId: undefined,
            parameters: {
                actionTypeRid,
                body,
            },
            message: `Failed to load unredacted action type metadata (${response.status})`,
        });
    }

    let payload: BulkLoadOntologyEntitiesResponse;
    try {
        payload = (await response.json()) as BulkLoadOntologyEntitiesResponse;
    } catch (error) {
        throw normalizeFoundryError(error);
    }

    const wire = payload.actionTypes?.[0]?.actionType;
    if (!wire) {
        return undefined;
    }

    const metadata = asRecord(wire.metadata);
    const actionTypeLogic = asRecord(wire.actionTypeLogic);
    const validation = asRecord(actionTypeLogic?.validation);
    const parameterValidations = (validation?.parameterValidations ?? {}) as Record<
        string,
        FoundryActionParameterValidationNode
    >;

    return {
        rid:
            (typeof wire.rid === "string" && wire.rid) ||
            (typeof metadata?.rid === "string" && metadata.rid) ||
            actionTypeRid,
        apiName: typeof metadata?.apiName === "string" ? metadata.apiName : undefined,
        parameterValidations,
        actionTypeLogic,
        metadata,
    };
}
