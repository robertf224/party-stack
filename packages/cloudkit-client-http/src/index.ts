import {
    CloudKitError,
    type CloudKitAccountStatus,
    type CloudKitAsset,
    type CloudKitClient,
    type CloudKitDatabaseScope,
    type CloudKitField,
    type CloudKitLocation,
    type CloudKitModifyOperation,
    type CloudKitRecord,
    type CloudKitScalar,
    type CloudKitZoneId,
} from "@party-stack/cloudkit-client";

export type CloudKitEnvironment = "development" | "production";

export interface CloudKitHttpTokenProvider {
    getWebAuthToken(): Promise<string | undefined>;
    handleAuthenticationRequired?(
        error: CloudKitError
    ): Promise<void>;
}

export interface CreateCloudKitHttpClientOptions {
    containerIdentifier: string;
    environment: CloudKitEnvironment;
    apiToken: string;
    tokenProvider?: CloudKitHttpTokenProvider;
    fetch?: typeof globalThis.fetch;
    baseUrl?: string;
}

type JsonObject = Record<string, unknown>;

const FIELD_TYPE_TO_WIRE = {
    string: "STRING",
    int64: "INT64",
    double: "DOUBLE",
    boolean: "BOOLEAN",
    date: "TIMESTAMP",
    bytes: "BYTES",
    location: "LOCATION",
    reference: "REFERENCE",
    asset: "ASSET",
} satisfies Record<CloudKitScalar["type"], string>;

const WIRE_TYPE_TO_FIELD = Object.fromEntries(
    Object.entries(FIELD_TYPE_TO_WIRE).map(([key, value]) => [value, key])
) as Record<string, CloudKitScalar["type"]>;

function asObject(value: unknown): JsonObject {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new CloudKitError(
            "invalidRequest",
            "CloudKit returned an invalid response."
        );
    }
    return value as JsonObject;
}

function asString(value: unknown, name: string): string {
    if (typeof value !== "string") {
        throw new CloudKitError(
            "invalidRequest",
            `CloudKit response is missing "${name}".`
        );
    }
    return value;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function zoneIdToWire(zone: CloudKitZoneId): JsonObject {
    return {
        zoneName: zone.zoneName,
        ...(zone.ownerRecordName
            ? {
                  ownerRecordName: zone.ownerRecordName,
              }
            : {}),
    };
}

function zoneIdFromWire(value: unknown): CloudKitZoneId {
    const zone = asObject(value);
    return {
        zoneName: asString(zone.zoneName, "zoneName"),
        ownerRecordName: optionalString(zone.ownerRecordName),
    };
}

function scalarValueToWire(field: CloudKitScalar): unknown {
    if (field.type === "date") {
        return Date.parse(field.value);
    }
    if (field.type === "reference") {
        return {
            ...field.value,
            zoneID: field.value.zone
                ? zoneIdToWire(field.value.zone)
                : undefined,
            zone: undefined,
        };
    }
    if (field.type === "location") {
        return {
            ...field.value,
            timestamp: field.value.timestamp
                ? Date.parse(field.value.timestamp)
                : undefined,
        };
    }
    return field.value;
}

function fieldValueToWire(field: CloudKitField): JsonObject {
    if (field.type === "list") {
        const elementType = field.value[0]?.type;
        if (
            elementType &&
            field.value.some(
                (entry) => entry.type !== elementType
            )
        ) {
            throw new CloudKitError(
                "invalidRequest",
                "CloudKit list fields must contain one scalar type."
            );
        }
        return {
            type: elementType
                ? `${FIELD_TYPE_TO_WIRE[elementType]}_LIST`
                : "STRING_LIST",
            value: field.value.map(scalarValueToWire),
        };
    }
    return {
        type: FIELD_TYPE_TO_WIRE[field.type],
        value: scalarValueToWire(field),
    };
}

function parseReference(value: unknown) {
    const reference = asObject(value);
    return {
        recordName: asString(reference.recordName, "recordName"),
        action:
            reference.action === "deleteSelf"
                ? ("deleteSelf" as const)
                : ("none" as const),
        zone: reference.zoneID
            ? zoneIdFromWire(reference.zoneID)
            : undefined,
    };
}

function scalarValueFromWire(
    type: CloudKitScalar["type"],
    value: unknown
): CloudKitScalar {
    switch (type) {
        case "date":
            return {
                type,
                value: new Date(Number(value)).toISOString(),
            };
        case "reference":
            return { type, value: parseReference(value) };
        case "string":
        case "int64":
        case "bytes":
            return { type, value: String(value) };
        case "double":
            return { type, value: Number(value) };
        case "boolean":
            return { type, value: Boolean(value) };
        case "location": {
            const location = asObject(value);
            return {
                type,
                value: {
                    latitude: Number(location.latitude),
                    longitude: Number(location.longitude),
                    altitude:
                        location.altitude === undefined
                            ? undefined
                            : Number(location.altitude),
                    horizontalAccuracy:
                        location.horizontalAccuracy === undefined
                            ? undefined
                            : Number(location.horizontalAccuracy),
                    verticalAccuracy:
                        location.verticalAccuracy === undefined
                            ? undefined
                            : Number(location.verticalAccuracy),
                    course:
                        location.course === undefined
                            ? undefined
                            : Number(location.course),
                    speed:
                        location.speed === undefined
                            ? undefined
                            : Number(location.speed),
                    timestamp:
                        location.timestamp === undefined
                            ? undefined
                            : new Date(
                                  Number(location.timestamp)
                              ).toISOString(),
                },
            };
        }
        case "asset":
            return {
                type,
                value: asObject(value) as CloudKitAsset,
            };
    }
}

function fieldValueFromWire(value: unknown): CloudKitField {
    const field = asObject(value);
    const wireType = asString(field.type, "field.type");
    const isList = wireType.endsWith("_LIST");
    const scalarWireType = isList
        ? wireType.slice(0, -"_LIST".length)
        : wireType;
    const type = WIRE_TYPE_TO_FIELD[scalarWireType];
    if (!type) {
        throw new CloudKitError(
            "invalidRequest",
            `Unsupported CloudKit field type "${wireType}".`
        );
    }

    if (isList) {
        if (!Array.isArray(field.value)) {
            throw new CloudKitError(
                "invalidRequest",
                `CloudKit ${wireType} field is not an array.`
            );
        }
        return {
            type: "list",
            value: field.value.map((entry) =>
                scalarValueFromWire(type, entry)
            ),
        };
    }
    return scalarValueFromWire(type, field.value);
}

function recordToWire(record: CloudKitRecord): JsonObject {
    return {
        recordName: record.recordName,
        recordType: record.recordType,
        ...(record.recordChangeTag
            ? { recordChangeTag: record.recordChangeTag }
            : {}),
        fields: Object.fromEntries(
            Object.entries(record.fields).map(([name, field]) => [
                name,
                fieldValueToWire(field),
            ])
        ),
    };
}

function recordFromWire(value: unknown): CloudKitRecord {
    const record = asObject(value);
    const fields = asObject(record.fields ?? {});
    return {
        recordName: asString(record.recordName, "recordName"),
        recordType: asString(record.recordType, "recordType"),
        recordChangeTag: optionalString(record.recordChangeTag),
        createdTimestamp: optionalString(
            asObject(record.created ?? {}).timestamp
        ),
        modifiedTimestamp: optionalString(
            asObject(record.modified ?? {}).timestamp
        ),
        fields: Object.fromEntries(
            Object.entries(fields).map(([name, field]) => [
                name,
                fieldValueFromWire(field),
            ])
        ),
    };
}

function operationToWire(operation: CloudKitModifyOperation): JsonObject {
    if (operation.type === "delete") {
        return {
            operationType: "delete",
            record: {
                recordName: operation.recordName,
                recordChangeTag: operation.recordChangeTag,
            },
        };
    }
    return {
        operationType: operation.type,
        record: recordToWire(operation.record),
    };
}

function errorCodeFromServer(code: unknown): ConstructorParameters<
    typeof CloudKitError
>[0] {
    switch (code) {
        case "AUTHENTICATION_REQUIRED":
        case "NOT_AUTHENTICATED":
            return "authenticationRequired";
        case "CONFLICT":
        case "SERVER_RECORD_CHANGED":
        case "BATCH_REQUEST_FAILED":
            return "conflict";
        case "CHANGE_TOKEN_EXPIRED":
            return "cursorExpired";
        case "NOT_FOUND":
        case "UNKNOWN_ITEM":
            return "notFound";
        case "QUOTA_EXCEEDED":
            return "quotaExceeded";
        case "TRY_AGAIN_LATER":
        case "REQUEST_RATE_LIMITED":
            return "rateLimited";
        case "SERVICE_UNAVAILABLE":
        case "ZONE_BUSY":
            return "serviceUnavailable";
        case "PERMISSION_FAILURE":
            return "permissionFailure";
        case "BAD_REQUEST":
        case "INVALID_ARGUMENTS":
            return "invalidRequest";
        default:
            return "unknown";
    }
}

function responseError(
    value: unknown,
    status?: number
): CloudKitError {
    const error = asObject(value);
    const serverCode =
        error.serverErrorCode ?? error.errorCode ?? error.code;
    const code =
        status === 401
            ? "authenticationRequired"
            : status === 429
              ? "rateLimited"
              : errorCodeFromServer(serverCode);
    const retryAfterSeconds = Number(
        error.retryAfter ?? error.retryAfterSeconds
    );
    return new CloudKitError(
        code,
        optionalString(error.reason) ??
            optionalString(error.message) ??
            `CloudKit request failed${serverCode ? ` (${String(serverCode)})` : ""}.`,
        {
            retryAfterMs: Number.isFinite(retryAfterSeconds)
                ? retryAfterSeconds * 1000
                : undefined,
            details: value,
        }
    );
}

function throwResponseError(value: unknown, status?: number): never {
    throw responseError(value, status);
}

function throwEmbeddedErrors(entries: unknown[]): void {
    const error = entries.find((entry) => {
        const candidate = asObject(entry);
        return (
            candidate.serverErrorCode !== undefined ||
            candidate.errorCode !== undefined
        );
    });
    if (error) throwResponseError(error);
}

export function createCloudKitHttpClient(
    options: CreateCloudKitHttpClientOptions
): CloudKitClient {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const baseUrl =
        options.baseUrl ?? "https://api.apple-cloudkit.com";

    const request = async (
        databaseScope: CloudKitDatabaseScope,
        path: string,
        body?: unknown,
        method = "POST"
    ): Promise<JsonObject> => {
        const url = new URL(
            `/database/1/${encodeURIComponent(options.containerIdentifier)}/${options.environment}/${databaseScope}/${path}`,
            baseUrl
        );
        url.searchParams.set("ckAPIToken", options.apiToken);
        const webAuthToken =
            await options.tokenProvider?.getWebAuthToken();
        if (webAuthToken) {
            url.searchParams.set("ckWebAuthToken", webAuthToken);
        }

        const response = await fetchImpl(url, {
            method,
            headers:
                body === undefined
                    ? undefined
                    : { "content-type": "application/json" },
            body:
                body === undefined ? undefined : JSON.stringify(body),
        });
        const result = (await response.json()) as unknown;
        if (!response.ok) {
            const error = responseError(
                result,
                response.status
            );
            if (
                error.code === "authenticationRequired" &&
                options.tokenProvider?.handleAuthenticationRequired
            ) {
                await options.tokenProvider.handleAuthenticationRequired(
                    error
                );
            }
            throw error;
        }
        const object = asObject(result);
        if (
            object.serverErrorCode !== undefined ||
            object.errorCode !== undefined
        ) {
            const error = responseError(object);
            if (
                error.code === "authenticationRequired" &&
                options.tokenProvider?.handleAuthenticationRequired
            ) {
                await options.tokenProvider.handleAuthenticationRequired(
                    error
                );
            }
            throw error;
        }
        return object;
    };

    return {
        async getAccountStatus(): Promise<CloudKitAccountStatus> {
            try {
                await request("public", "users/current", undefined, "GET");
                return "available";
            } catch (error) {
                if (
                    error instanceof CloudKitError &&
                    error.code === "authenticationRequired"
                ) {
                    return "noAccount";
                }
                return "couldNotDetermine";
            }
        },
        async ensureZone(location) {
            try {
                await request(
                    location.databaseScope,
                    "zones/modify",
                    {
                        operations: [
                            {
                                operationType: "create",
                                zone: {
                                    zoneID: zoneIdToWire(
                                        location.zone
                                    ),
                                },
                            },
                        ],
                    }
                );
            } catch (error) {
                if (
                    error instanceof CloudKitError &&
                    error.code === "conflict"
                ) {
                    return;
                }
                throw error;
            }
        },
        async fetchZones(databaseScope) {
            const result = await request(
                databaseScope,
                "zones/list",
                {}
            );
            const zones = Array.isArray(result.zones)
                ? result.zones
                : [];
            throwEmbeddedErrors(zones);
            return zones.map((entry) =>
                zoneIdFromWire(asObject(entry).zoneID)
            );
        },
        async fetchRecords({ location, recordNames }) {
            const result = await request(
                location.databaseScope,
                "records/lookup",
                {
                    zoneID: zoneIdToWire(location.zone),
                    numbersAsStrings: true,
                    records: recordNames.map((recordName) => ({
                        recordName,
                    })),
                }
            );
            const records = Array.isArray(result.records)
                ? result.records
                : [];
            const unexpectedErrors = records.filter((entry) => {
                const candidate = asObject(entry);
                const code =
                    candidate.serverErrorCode ??
                    candidate.errorCode;
                return (
                    code !== undefined &&
                    code !== "NOT_FOUND" &&
                    code !== "UNKNOWN_ITEM"
                );
            });
            throwEmbeddedErrors(unexpectedErrors);
            return records
                .filter(
                    (entry) =>
                        asObject(entry).recordType !== undefined
                )
                .map(recordFromWire);
        },
        async fetchZoneChanges({
            location,
            cursor,
            recordTypes,
            limit,
        }) {
            const result = await request(
                location.databaseScope,
                "changes/zone",
                {
                    zones: [
                        {
                            zoneID: zoneIdToWire(location.zone),
                            ...(cursor ? { syncToken: cursor } : {}),
                            ...(recordTypes
                                ? {
                                      desiredRecordTypes:
                                          recordTypes,
                                  }
                                : {}),
                            ...(limit ? { resultsLimit: limit } : {}),
                        },
                    ],
                    numbersAsStrings: true,
                }
            );
            const zoneResult = asObject(
                (result.zones as unknown[] | undefined)?.[0]
            );
            if (
                zoneResult.serverErrorCode !== undefined ||
                zoneResult.errorCode !== undefined
            ) {
                throwResponseError(zoneResult);
            }
            const records = Array.isArray(zoneResult.records)
                ? zoneResult.records
                : [];
            const explicitlyDeleted = Array.isArray(
                zoneResult.deleted
            )
                ? zoneResult.deleted
                : [];
            const deleted = [
                ...explicitlyDeleted,
                ...records.filter(
                    (entry) => asObject(entry).deleted === true
                ),
            ];
            return {
                records: records
                    .filter(
                        (entry) =>
                            asObject(entry).deleted !== true
                    )
                    .map(recordFromWire),
                deleted: deleted.map((entry) => {
                    const value = asObject(entry);
                    return {
                        recordName: asString(
                            value.recordName,
                            "recordName"
                        ),
                        recordType: optionalString(
                            value.recordType
                        ),
                    };
                }),
                cursor: asString(
                    zoneResult.syncToken,
                    "syncToken"
                ),
                moreComing: zoneResult.moreComing === true,
            };
        },
        async modifyRecords({ location, operations, atomic = true }) {
            const result = await request(
                location.databaseScope,
                "records/modify",
                {
                    zoneID: zoneIdToWire(location.zone),
                    operations: operations.map(operationToWire),
                    atomic,
                    numbersAsStrings: true,
                }
            );
            const entries = Array.isArray(result.records)
                ? result.records
                : [];
            throwEmbeddedErrors(entries);
            return {
                records: entries
                    .filter(
                        (entry) =>
                            asObject(entry).recordType !== undefined
                    )
                    .map(recordFromWire),
                deletedRecordNames: entries.flatMap((entry) => {
                    const value = asObject(entry);
                    return value.deleted === true &&
                        typeof value.recordName === "string"
                        ? [value.recordName]
                        : [];
                }),
            };
        },
        async uploadAsset({
            location,
            recordType,
            fieldName,
            blob,
        }) {
            const result = await request(
                location.databaseScope,
                "assets/upload",
                {
                    zoneID: zoneIdToWire(location.zone),
                    tokens: [{ recordType, fieldName }],
                }
            );
            const token = asObject(
                (result.tokens as unknown[] | undefined)?.[0]
            );
            const uploadUrl = asString(token.url, "asset upload URL");
            const uploadResponse = await fetchImpl(uploadUrl, {
                method: "POST",
                body: blob,
            });
            const asset = (await uploadResponse.json()) as unknown;
            if (!uploadResponse.ok) {
                throwResponseError(asset, uploadResponse.status);
            }
            return asObject(asset) as CloudKitAsset;
        },
        async downloadAsset(asset: CloudKitAsset) {
            if (!asset.downloadURL) {
                throw new CloudKitError(
                    "notFound",
                    "CloudKit asset has no download URL."
                );
            }
            const response = await fetchImpl(asset.downloadURL);
            if (!response.ok) {
                throw new CloudKitError(
                    response.status === 404
                        ? "notFound"
                        : "serviceUnavailable",
                    `CloudKit asset download failed (${response.status}).`
                );
            }
            return response.blob();
        },
    };
}
