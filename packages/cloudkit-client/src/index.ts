export type CloudKitDatabaseScope = "private" | "public" | "shared";

export interface CloudKitZoneId {
    zoneName: string;
    ownerRecordName?: string;
}

export interface CloudKitLocation {
    databaseScope: CloudKitDatabaseScope;
    zone: CloudKitZoneId;
}

export interface CloudKitReference {
    recordName: string;
    action?: "none" | "deleteSelf";
    zone?: CloudKitZoneId;
}

export interface CloudKitAsset {
    downloadURL?: string;
    fileURL?: string;
    fileChecksum?: string;
    referenceChecksum?: string;
    wrappingKey?: string;
    receipt?: string;
    size?: number;
}

export interface CloudKitLocationValue {
    latitude: number;
    longitude: number;
    altitude?: number;
    horizontalAccuracy?: number;
    verticalAccuracy?: number;
    course?: number;
    speed?: number;
    timestamp?: string;
}

export type CloudKitScalar =
    | { type: "string"; value: string }
    | { type: "int64"; value: string }
    | { type: "double"; value: number }
    | { type: "boolean"; value: boolean }
    | { type: "date"; value: string }
    | { type: "bytes"; value: string }
    | { type: "location"; value: CloudKitLocationValue }
    | { type: "reference"; value: CloudKitReference }
    | { type: "asset"; value: CloudKitAsset };

export type CloudKitField =
    | CloudKitScalar
    | { type: "list"; value: CloudKitScalar[] };

export interface CloudKitRecord {
    recordName: string;
    recordType: string;
    fields: Record<string, CloudKitField>;
    recordChangeTag?: string;
    createdTimestamp?: string;
    modifiedTimestamp?: string;
}

export interface CloudKitDeletedRecord {
    recordName: string;
    recordType?: string;
}

export type CloudKitModifyOperation =
    | {
          type: "create";
          record: CloudKitRecord;
      }
    | {
          type: "update" | "replace";
          record: CloudKitRecord & { recordChangeTag: string };
      }
    | {
          type: "delete";
          recordName: string;
          recordChangeTag: string;
      };

export interface CloudKitModifyResult {
    records: CloudKitRecord[];
    deletedRecordNames: string[];
}

export interface CloudKitZoneChangesResult {
    records: CloudKitRecord[];
    deleted: CloudKitDeletedRecord[];
    cursor: string;
    moreComing: boolean;
}

export type CloudKitAccountStatus =
    | "available"
    | "noAccount"
    | "restricted"
    | "couldNotDetermine";

export type CloudKitErrorCode =
    | "authenticationRequired"
    | "conflict"
    | "cursorExpired"
    | "notFound"
    | "quotaExceeded"
    | "rateLimited"
    | "serviceUnavailable"
    | "invalidRequest"
    | "permissionFailure"
    | "unknown";

const RETRYABLE_CODES = new Set<CloudKitErrorCode>([
    "conflict",
    "rateLimited",
    "serviceUnavailable",
]);

export class CloudKitError extends Error {
    readonly code: CloudKitErrorCode;
    readonly retryAfterMs?: number;
    readonly details?: unknown;

    constructor(
        code: CloudKitErrorCode,
        message: string,
        options?: {
            cause?: unknown;
            retryAfterMs?: number;
            details?: unknown;
        }
    ) {
        super(message, { cause: options?.cause });
        this.name = "CloudKitError";
        this.code = code;
        this.retryAfterMs = options?.retryAfterMs;
        this.details = options?.details;
    }

    get retryable(): boolean {
        return RETRYABLE_CODES.has(this.code);
    }
}

export function isCloudKitError(value: unknown): value is CloudKitError {
    return value instanceof CloudKitError;
}

export interface CloudKitClient {
    getAccountStatus(): Promise<CloudKitAccountStatus>;
    ensureZone(location: CloudKitLocation): Promise<void>;
    fetchZones(databaseScope: CloudKitDatabaseScope): Promise<CloudKitZoneId[]>;
    fetchRecords(options: {
        location: CloudKitLocation;
        recordNames: string[];
    }): Promise<CloudKitRecord[]>;
    fetchZoneChanges(options: {
        location: CloudKitLocation;
        cursor?: string;
        recordTypes?: string[];
        limit?: number;
    }): Promise<CloudKitZoneChangesResult>;
    modifyRecords(options: {
        location: CloudKitLocation;
        operations: CloudKitModifyOperation[];
        atomic?: boolean;
    }): Promise<CloudKitModifyResult>;
    uploadAsset(options: {
        location: CloudKitLocation;
        recordType: string;
        fieldName: string;
        blob: Blob;
    }): Promise<CloudKitAsset>;
    downloadAsset(asset: CloudKitAsset): Promise<Blob>;
    subscribeToChanges?(listener: () => void): () => void;
    cleanup?(): void | Promise<void>;
}

export function cloudKitLocationKey(location: CloudKitLocation): string {
    return [
        location.databaseScope,
        location.zone.ownerRecordName ?? "",
        location.zone.zoneName,
    ].join(":");
}
