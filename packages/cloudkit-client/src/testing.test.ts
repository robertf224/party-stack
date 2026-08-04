import { describe, expect, it, vi } from "vitest";
import type { CloudKitLocation } from "./index.js";
import {
    assertCloudKitZone,
    createMemoryCloudKitClient,
} from "./testing.js";

const location: CloudKitLocation = {
    databaseScope: "private",
    zone: { zoneName: "party-stack" },
};

describe("memory CloudKit client", () => {
    it("creates zones and reports account status", async () => {
        const client = createMemoryCloudKitClient();
        await client.ensureZone(location);

        expect(await client.getAccountStatus()).toBe("available");
        assertCloudKitZone(
            await client.fetchZones("private"),
            location.zone
        );

        client.setAccountStatus("noAccount");
        expect(await client.getAccountStatus()).toBe("noAccount");
    });

    it("modifies records and pages incremental changes", async () => {
        const client = createMemoryCloudKitClient();
        await client.ensureZone(location);
        const listener = vi.fn();
        client.subscribeToChanges?.(listener);

        const created = await client.modifyRecords({
            location,
            operations: [
                {
                    type: "create",
                    record: {
                        recordName: "JournalEntry:1",
                        recordType: "PS_JournalEntry",
                        fields: {
                            title: { type: "string", value: "First" },
                        },
                    },
                },
                {
                    type: "create",
                    record: {
                        recordName: "JournalEntry:2",
                        recordType: "PS_JournalEntry",
                        fields: {
                            title: { type: "string", value: "Second" },
                        },
                    },
                },
            ],
        });

        expect(created.records).toHaveLength(2);
        expect(listener).toHaveBeenCalledOnce();

        const firstPage = await client.fetchZoneChanges({
            location,
            limit: 1,
        });
        expect(firstPage.records).toHaveLength(1);
        expect(firstPage.moreComing).toBe(true);

        const secondPage = await client.fetchZoneChanges({
            location,
            cursor: firstPage.cursor,
            limit: 1,
        });
        expect(secondPage.records).toHaveLength(1);
        expect(secondPage.moreComing).toBe(false);

        const first = created.records[0]!;
        const updated = await client.modifyRecords({
            location,
            operations: [
                {
                    type: "update",
                    record: {
                        ...first,
                        recordChangeTag: first.recordChangeTag!,
                        fields: {
                            title: { type: "string", value: "Updated" },
                        },
                    },
                },
            ],
        });
        expect(updated.records[0]?.fields.title).toEqual({
            type: "string",
            value: "Updated",
        });
    });

    it("enforces change tags atomically", async () => {
        const client = createMemoryCloudKitClient();
        await client.ensureZone(location);
        const [record] = (
            await client.modifyRecords({
                location,
                operations: [
                    {
                        type: "create",
                        record: {
                            recordName: "JournalEntry:1",
                            recordType: "PS_JournalEntry",
                            fields: {},
                        },
                    },
                ],
            })
        ).records;

        await expect(
            client.modifyRecords({
                location,
                operations: [
                    {
                        type: "delete",
                        recordName: record!.recordName,
                        recordChangeTag: "stale",
                    },
                    {
                        type: "create",
                        record: {
                            recordName: "JournalEntry:2",
                            recordType: "PS_JournalEntry",
                            fields: {},
                        },
                    },
                ],
            })
        ).rejects.toMatchObject({
            code: "conflict",
        });
        expect(
            await client.fetchRecords({
                location,
                recordNames: ["JournalEntry:1", "JournalEntry:2"],
            })
        ).toHaveLength(1);
    });

    it("round trips assets and reports expired cursors", async () => {
        const client = createMemoryCloudKitClient();
        await client.ensureZone(location);
        const asset = await client.uploadAsset({
            location,
            recordType: "PartyStackAttachment",
            fieldName: "asset",
            blob: new Blob(["hello"], { type: "text/plain" }),
        });

        expect(await (await client.downloadAsset(asset)).text()).toBe(
            "hello"
        );

        client.expireCursorsBefore(2);
        await expect(
            client.fetchZoneChanges({ location, cursor: "1" })
        ).rejects.toMatchObject({
            code: "cursorExpired",
        });
    });
});
