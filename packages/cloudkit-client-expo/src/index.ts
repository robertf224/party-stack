import { requireNativeModule } from "expo-modules-core";
import {
    CloudKitError,
    type CloudKitAccountStatus,
    type CloudKitAsset,
    type CloudKitClient,
    type CloudKitDatabaseScope,
    type CloudKitLocation,
    type CloudKitModifyOperation,
    type CloudKitModifyResult,
    type CloudKitRecord,
    type CloudKitZoneChangesResult,
    type CloudKitZoneId,
} from "@party-stack/cloudkit-client";

interface NativeCloudKitModule {
    getAccountStatus(
        containerIdentifier: string
    ): Promise<CloudKitAccountStatus>;
    ensureZone(
        containerIdentifier: string,
        location: CloudKitLocation
    ): Promise<void>;
    ensureSubscription(
        containerIdentifier: string,
        location: CloudKitLocation
    ): Promise<void>;
    fetchZones(
        containerIdentifier: string,
        databaseScope: CloudKitDatabaseScope
    ): Promise<CloudKitZoneId[]>;
    fetchRecords(
        containerIdentifier: string,
        location: CloudKitLocation,
        recordNames: string[]
    ): Promise<CloudKitRecord[]>;
    fetchZoneChanges(
        containerIdentifier: string,
        location: CloudKitLocation,
        cursor: string | null,
        recordTypes: string[] | null,
        limit: number | null
    ): Promise<CloudKitZoneChangesResult>;
    modifyRecords(
        containerIdentifier: string,
        location: CloudKitLocation,
        operations: CloudKitModifyOperation[],
        atomic: boolean
    ): Promise<CloudKitModifyResult>;
    prepareAsset(
        dataBase64: string,
        contentType: string
    ): Promise<CloudKitAsset>;
    readAsset(asset: CloudKitAsset): Promise<{
        dataBase64: string;
        contentType: string;
    }>;
    addListener(
        eventName: "onCloudKitChange",
        listener: () => void
    ): { remove(): void };
}

export interface CreateExpoCloudKitClientOptions {
    containerIdentifier: string;
    nativeModule?: NativeCloudKitModule;
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(
            ...bytes.subarray(offset, offset + chunkSize)
        );
    }
    return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) =>
        character.charCodeAt(0)
    );
}

function normalizeNativeError(error: unknown): never {
    if (error instanceof CloudKitError) throw error;
    const candidate =
        typeof error === "object" && error !== null
            ? (error as {
                  code?: unknown;
                  message?: unknown;
              })
            : {};
    const nativeCode =
        typeof candidate.code === "string"
            ? candidate.code
            : "unknown";
    const code =
        nativeCode.includes("NotAuthenticated")
            ? "authenticationRequired"
            : nativeCode.includes("ServerRecordChanged")
              ? "conflict"
              : nativeCode.includes("ChangeTokenExpired")
                ? "cursorExpired"
                : nativeCode.includes("QuotaExceeded")
                  ? "quotaExceeded"
                  : nativeCode.includes("RequestRateLimited")
                    ? "rateLimited"
                    : nativeCode.includes("UnknownItem")
                      ? "notFound"
                      : "unknown";
    throw new CloudKitError(
        code,
        typeof candidate.message === "string"
            ? candidate.message
            : "Native CloudKit operation failed.",
        { cause: error }
    );
}

async function nativeCall<T>(
    operation: () => Promise<T>
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        normalizeNativeError(error);
    }
}

export function createExpoCloudKitClient(
    options: CreateExpoCloudKitClientOptions
): CloudKitClient {
    const nativeModule =
        options.nativeModule ??
        requireNativeModule<NativeCloudKitModule>(
            "PartyStackCloudKitClient"
        );
    const containerIdentifier = options.containerIdentifier;
    const changeListeners = new Set<() => void>();
    let nativeChangeSubscription:
        | { remove(): void }
        | undefined;

    return {
        getAccountStatus: () =>
            nativeCall(() =>
                nativeModule.getAccountStatus(containerIdentifier)
            ),
        ensureZone: async (location) => {
            await nativeCall(() =>
                nativeModule.ensureZone(
                    containerIdentifier,
                    location
                )
            );
            void nativeCall(() =>
                nativeModule.ensureSubscription(
                    containerIdentifier,
                    location
                )
            ).catch((error: unknown) => {
                console.warn(
                    "Failed to create CloudKit zone subscription.",
                    error
                );
            });
        },
        fetchZones: (databaseScope) =>
            nativeCall(() =>
                nativeModule.fetchZones(
                    containerIdentifier,
                    databaseScope
                )
            ),
        fetchRecords: ({ location, recordNames }) =>
            nativeCall(() =>
                nativeModule.fetchRecords(
                    containerIdentifier,
                    location,
                    recordNames
                )
            ),
        fetchZoneChanges: ({
            location,
            cursor,
            recordTypes,
            limit,
        }) =>
            nativeCall(() =>
                nativeModule.fetchZoneChanges(
                    containerIdentifier,
                    location,
                    cursor ?? null,
                    recordTypes ?? null,
                    limit ?? null
                )
            ),
        modifyRecords: ({
            location,
            operations,
            atomic = true,
        }) =>
            nativeCall(() =>
                nativeModule.modifyRecords(
                    containerIdentifier,
                    location,
                    operations,
                    atomic
                )
            ),
        async uploadAsset({ blob }) {
            const bytes = new Uint8Array(
                await blob.arrayBuffer()
            );
            return nativeCall(() =>
                nativeModule.prepareAsset(
                    bytesToBase64(bytes),
                    blob.type || "application/octet-stream"
                )
            );
        },
        async downloadAsset(asset) {
            const value = await nativeCall(() =>
                nativeModule.readAsset(asset)
            );
            return new Blob([base64ToBytes(value.dataBase64)], {
                type: value.contentType,
            });
        },
        subscribeToChanges(listener) {
            changeListeners.add(listener);
            nativeChangeSubscription ??=
                nativeModule.addListener(
                    "onCloudKitChange",
                    () => {
                        for (const changeListener of changeListeners) {
                            changeListener();
                        }
                    }
                );
            return () => {
                changeListeners.delete(listener);
                if (changeListeners.size === 0) {
                    nativeChangeSubscription?.remove();
                    nativeChangeSubscription = undefined;
                }
            };
        },
        cleanup() {
            nativeChangeSubscription?.remove();
            nativeChangeSubscription = undefined;
            changeListeners.clear();
        },
    };
}
