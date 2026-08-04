import { describe, expect, it, vi } from "vitest";
import type { CloudKitLocation } from "@party-stack/cloudkit-client";

vi.mock("expo-modules-core", () => ({
    requireNativeModule: vi.fn(),
}));

import { createExpoCloudKitClient } from "./index.js";

const location: CloudKitLocation = {
    databaseScope: "private",
    zone: { zoneName: "party-stack" },
};

function createNativeModule() {
    return {
        getAccountStatus: vi.fn().mockResolvedValue("available"),
        ensureZone: vi.fn().mockResolvedValue(undefined),
        ensureSubscription: vi.fn().mockResolvedValue(undefined),
        fetchZones: vi.fn().mockResolvedValue([location.zone]),
        fetchRecords: vi.fn().mockResolvedValue([]),
        fetchZoneChanges: vi.fn().mockResolvedValue({
            records: [],
            deleted: [],
            cursor: "cursor",
            moreComing: false,
        }),
        modifyRecords: vi.fn().mockResolvedValue({
            records: [],
            deletedRecordNames: [],
        }),
        prepareAsset: vi.fn().mockResolvedValue({
            fileURL: "file:///tmp/asset",
            size: 5,
        }),
        readAsset: vi.fn().mockResolvedValue({
            dataBase64: btoa("hello"),
            contentType: "text/plain",
        }),
        addListener: vi.fn().mockReturnValue({
            remove: vi.fn(),
        }),
    };
}

describe("Expo CloudKit client", () => {
    it("delegates normalized operations to the native module", async () => {
        const nativeModule = createNativeModule();
        const client = createExpoCloudKitClient({
            containerIdentifier:
                "iCloud.dev.party-stack.journal",
            nativeModule,
        });

        await client.ensureZone(location);
        await client.fetchZoneChanges({ location });

        expect(nativeModule.ensureZone).toHaveBeenCalledWith(
            "iCloud.dev.party-stack.journal",
            location
        );
        expect(
            nativeModule.fetchZoneChanges
        ).toHaveBeenCalledWith(
            "iCloud.dev.party-stack.journal",
            location,
            null,
            null,
            null
        );
    });

    it("bridges assets through base64", async () => {
        const nativeModule = createNativeModule();
        const client = createExpoCloudKitClient({
            containerIdentifier:
                "iCloud.dev.party-stack.journal",
            nativeModule,
        });

        const asset = await client.uploadAsset({
            location,
            recordType: "PartyStackAttachment",
            fieldName: "asset",
            blob: new Blob(["hello"], { type: "text/plain" }),
        });
        expect(nativeModule.prepareAsset).toHaveBeenCalledWith(
            btoa("hello"),
            "text/plain"
        );
        expect(await (await client.downloadAsset(asset)).text()).toBe(
            "hello"
        );
    });

    it("normalizes native CloudKit errors", async () => {
        const nativeModule = createNativeModule();
        nativeModule.fetchZones.mockRejectedValue({
            code: "CKErrorServerRecordChanged",
            message: "The record changed.",
        });
        const client = createExpoCloudKitClient({
            containerIdentifier:
                "iCloud.dev.party-stack.journal",
            nativeModule,
        });

        await expect(client.fetchZones("private")).rejects.toMatchObject({
            code: "conflict",
            message: "The record changed.",
        });
    });
});
