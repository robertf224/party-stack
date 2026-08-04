import {
    CloudKitError,
    cloudKitLocationKey,
    type CloudKitAccountStatus,
    type CloudKitAsset,
    type CloudKitClient,
    type CloudKitDatabaseScope,
    type CloudKitDeletedRecord,
    type CloudKitLocation,
    type CloudKitModifyOperation,
    type CloudKitRecord,
    type CloudKitZoneId,
} from "./index.js";

interface MemoryChange {
    sequence: number;
    record?: CloudKitRecord;
    deleted?: CloudKitDeletedRecord;
}

interface MemoryZone {
    location: CloudKitLocation;
    records: Map<string, CloudKitRecord>;
    changes: MemoryChange[];
    sequence: number;
}

function cloneRecord(record: CloudKitRecord): CloudKitRecord {
    return structuredClone(record);
}

function zoneIdEquals(left: CloudKitZoneId, right: CloudKitZoneId): boolean {
    return (
        left.zoneName === right.zoneName &&
        left.ownerRecordName === right.ownerRecordName
    );
}

export interface MemoryCloudKitClient extends CloudKitClient {
    setAccountStatus(status: CloudKitAccountStatus): void;
    expireCursorsBefore(sequence: number): void;
}

export function createMemoryCloudKitClient(): MemoryCloudKitClient {
    const zones = new Map<string, MemoryZone>();
    const assets = new Map<string, Blob>();
    const listeners = new Set<() => void>();
    let accountStatus: CloudKitAccountStatus = "available";
    let minimumCursor = 0;

    const getZone = (location: CloudKitLocation): MemoryZone => {
        const zone = zones.get(cloudKitLocationKey(location));
        if (!zone) {
            throw new CloudKitError(
                "notFound",
                `CloudKit zone "${location.zone.zoneName}" was not found.`
            );
        }
        return zone;
    };

    const notify = () => {
        for (const listener of listeners) listener();
    };

    return {
        setAccountStatus(status) {
            accountStatus = status;
        },
        expireCursorsBefore(sequence) {
            minimumCursor = sequence;
        },
        getAccountStatus: () => Promise.resolve(accountStatus),
        ensureZone(location) {
            const key = cloudKitLocationKey(location);
            if (!zones.has(key)) {
                zones.set(key, {
                    location: structuredClone(location),
                    records: new Map(),
                    changes: [],
                    sequence: 0,
                });
            }
            return Promise.resolve();
        },
        fetchZones(databaseScope: CloudKitDatabaseScope) {
            return Promise.resolve(
                [...zones.values()]
                    .filter(
                        (zone) =>
                            zone.location.databaseScope === databaseScope
                    )
                    .map((zone) => structuredClone(zone.location.zone))
            );
        },
        fetchRecords({ location, recordNames }) {
            const zone = getZone(location);
            return Promise.resolve(
                recordNames.flatMap((recordName) => {
                    const record = zone.records.get(recordName);
                    return record ? [cloneRecord(record)] : [];
                })
            );
        },
        async fetchZoneChanges({
            location,
            cursor,
            recordTypes,
            limit = 200,
        }) {
            const zone = getZone(location);
            const sequence = cursor === undefined ? 0 : Number(cursor);
            if (!Number.isSafeInteger(sequence) || sequence < minimumCursor) {
                throw new CloudKitError(
                    "cursorExpired",
                    "The CloudKit change cursor has expired."
                );
            }

            const matching = zone.changes.filter((change) => {
                if (change.sequence <= sequence) return false;
                if (!recordTypes || recordTypes.length === 0) return true;
                const recordType =
                    change.record?.recordType ?? change.deleted?.recordType;
                return recordType
                    ? recordTypes.includes(recordType)
                    : true;
            });
            const page = matching.slice(0, limit);
            const nextCursor =
                page.at(-1)?.sequence ?? Math.max(sequence, zone.sequence);

            return {
                records: page.flatMap((change) =>
                    change.record ? [cloneRecord(change.record)] : []
                ),
                deleted: page.flatMap((change) =>
                    change.deleted ? [structuredClone(change.deleted)] : []
                ),
                cursor: String(nextCursor),
                moreComing: matching.length > page.length,
            };
        },
        async modifyRecords({ location, operations, atomic = true }) {
            const zone = getZone(location);
            const nextRecords = new Map(
                [...zone.records].map(([key, value]) => [
                    key,
                    cloneRecord(value),
                ])
            );
            const records: CloudKitRecord[] = [];
            const deletedRecordNames: string[] = [];
            const pendingChanges: Array<
                Omit<MemoryChange, "sequence">
            > = [];

            const apply = (operation: CloudKitModifyOperation) => {
                if (operation.type === "create") {
                    if (nextRecords.has(operation.record.recordName)) {
                        throw new CloudKitError(
                            "conflict",
                            `Record "${operation.record.recordName}" already exists.`
                        );
                    }
                    const record = {
                        ...cloneRecord(operation.record),
                        recordChangeTag: crypto.randomUUID(),
                    };
                    nextRecords.set(record.recordName, record);
                    records.push(cloneRecord(record));
                    pendingChanges.push({ record });
                    return;
                }

                if (operation.type === "delete") {
                    const existing = nextRecords.get(operation.recordName);
                    if (!existing) {
                        throw new CloudKitError(
                            "notFound",
                            `Record "${operation.recordName}" was not found.`
                        );
                    }
                    if (
                        existing.recordChangeTag !==
                        operation.recordChangeTag
                    ) {
                        throw new CloudKitError(
                            "conflict",
                            `Record "${operation.recordName}" changed.`
                        );
                    }
                    nextRecords.delete(operation.recordName);
                    deletedRecordNames.push(operation.recordName);
                    pendingChanges.push({
                        deleted: {
                            recordName: operation.recordName,
                            recordType: existing.recordType,
                        },
                    });
                    return;
                }

                const existing = nextRecords.get(
                    operation.record.recordName
                );
                if (!existing) {
                    throw new CloudKitError(
                        "notFound",
                        `Record "${operation.record.recordName}" was not found.`
                    );
                }
                if (
                    existing.recordChangeTag !==
                    operation.record.recordChangeTag
                ) {
                    throw new CloudKitError(
                        "conflict",
                        `Record "${operation.record.recordName}" changed.`
                    );
                }
                const record: CloudKitRecord = {
                    ...cloneRecord(operation.record),
                    fields:
                        operation.type === "update"
                            ? {
                                  ...existing.fields,
                                  ...structuredClone(operation.record.fields),
                              }
                            : structuredClone(operation.record.fields),
                    recordChangeTag: crypto.randomUUID(),
                };
                nextRecords.set(record.recordName, record);
                records.push(cloneRecord(record));
                pendingChanges.push({ record });
            };

            try {
                for (const operation of operations) apply(operation);
            } catch (error) {
                if (atomic) throw error;
            }

            zone.records = nextRecords;
            for (const change of pendingChanges) {
                zone.sequence += 1;
                zone.changes.push({
                    ...change,
                    sequence: zone.sequence,
                });
            }
            if (pendingChanges.length > 0) notify();
            return { records, deletedRecordNames };
        },
        async uploadAsset({ blob }) {
            const receipt = crypto.randomUUID();
            assets.set(receipt, blob);
            return {
                receipt,
                size: blob.size,
            };
        },
        async downloadAsset(asset: CloudKitAsset) {
            const blob = asset.receipt
                ? assets.get(asset.receipt)
                : undefined;
            if (!blob) {
                throw new CloudKitError(
                    "notFound",
                    "CloudKit asset was not found."
                );
            }
            return blob;
        },
        subscribeToChanges(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        cleanup() {
            listeners.clear();
        },
    };
}

export function assertCloudKitZone(
    zones: CloudKitZoneId[],
    expected: CloudKitZoneId
): void {
    if (!zones.some((zone) => zoneIdEquals(zone, expected))) {
        throw new Error(
            `Expected CloudKit zone "${expected.zoneName}" was not found.`
        );
    }
}
