import { describe, expect, it, vi } from "vitest";
import type { CloudKitLocation } from "@party-stack/cloudkit-client";
import { createCloudKitHttpClient } from "./index.js";

const location: CloudKitLocation = {
    databaseScope: "private",
    zone: { zoneName: "party-stack" },
};

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
    });
}

describe("CloudKit HTTP client", () => {
    it("encodes atomic record modifications", async () => {
        const fetch = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValue(
                jsonResponse({
                    records: [
                        {
                            recordName: "JournalEntry:1",
                            recordType: "PS_JournalEntry",
                            recordChangeTag: "tag-1",
                            fields: {
                                title: {
                                    type: "STRING",
                                    value: "Hello",
                                },
                                createdAt: {
                                    type: "TIMESTAMP",
                                    value: 1_700_000_000_000,
                                },
                                location: {
                                    type: "LOCATION",
                                    value: {
                                        latitude: 40.7,
                                        longitude: -74,
                                    },
                                },
                                tags: {
                                    type: "STRING_LIST",
                                    value: ["city", "coast"],
                                },
                            },
                        },
                    ],
                })
            );
        const client = createCloudKitHttpClient({
            containerIdentifier: "iCloud.dev.party-stack.journal",
            environment: "development",
            apiToken: "api-token",
            tokenProvider: {
                getWebAuthToken: () =>
                    Promise.resolve("user-token"),
            },
            fetch,
        });

        const result = await client.modifyRecords({
            location,
            operations: [
                {
                    type: "create",
                    record: {
                        recordName: "JournalEntry:1",
                        recordType: "PS_JournalEntry",
                        fields: {
                            title: {
                                type: "string",
                                value: "Hello",
                            },
                            createdAt: {
                                type: "date",
                                value: "2023-11-14T22:13:20.000Z",
                            },
                            location: {
                                type: "location",
                                value: {
                                    latitude: 40.7,
                                    longitude: -74,
                                },
                            },
                            tags: {
                                type: "list",
                                value: [
                                    {
                                        type: "string",
                                        value: "city",
                                    },
                                    {
                                        type: "string",
                                        value: "coast",
                                    },
                                ],
                            },
                        },
                    },
                },
            ],
        });

        const [url, init] = fetch.mock.calls[0]!;
        expect(String(url)).toContain(
            "/development/private/records/modify"
        );
        expect(String(url)).toContain("ckAPIToken=api-token");
        expect(String(url)).toContain(
            "ckWebAuthToken=user-token"
        );
        expect(JSON.parse(String(init?.body))).toMatchObject({
            atomic: true,
            zoneID: { zoneName: "party-stack" },
            operations: [
                {
                    operationType: "create",
                    record: {
                        fields: {
                            createdAt: {
                                type: "TIMESTAMP",
                                value: 1_700_000_000_000,
                            },
                            location: {
                                type: "LOCATION",
                                value: {
                                    latitude: 40.7,
                                    longitude: -74,
                                },
                            },
                            tags: {
                                type: "STRING_LIST",
                                value: ["city", "coast"],
                            },
                        },
                    },
                },
            ],
        });
        expect(result.records[0]?.fields.createdAt).toEqual({
            type: "date",
            value: "2023-11-14T22:13:20.000Z",
        });
        expect(result.records[0]?.fields.location).toEqual({
            type: "location",
            value: {
                latitude: 40.7,
                longitude: -74,
            },
        });
        expect(result.records[0]?.fields.tags).toEqual({
            type: "list",
            value: [
                { type: "string", value: "city" },
                { type: "string", value: "coast" },
            ],
        });
    });

    it("decodes paged zone changes and deletions", async () => {
        const fetch = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValue(
                jsonResponse({
                    zones: [
                        {
                            syncToken: "cursor-2",
                            moreComing: true,
                            records: [
                                {
                                    recordName: "JournalEntry:1",
                                    recordType: "PS_JournalEntry",
                                    fields: {},
                                },
                                {
                                    recordName: "JournalEntry:deleted",
                                    deleted: true,
                                },
                            ],
                            deleted: [
                                {
                                    recordName: "JournalEntry:0",
                                    recordType: "PS_JournalEntry",
                                },
                            ],
                        },
                    ],
                })
            );
        const client = createCloudKitHttpClient({
            containerIdentifier: "iCloud.dev.party-stack.journal",
            environment: "development",
            apiToken: "api-token",
            fetch,
        });

        const result = await client.fetchZoneChanges({
            location,
            cursor: "cursor-1",
            recordTypes: ["PS_JournalEntry"],
        });

        expect(result).toMatchObject({
            cursor: "cursor-2",
            moreComing: true,
            deleted: [
                {
                    recordName: "JournalEntry:0",
                    recordType: "PS_JournalEntry",
                },
                {
                    recordName: "JournalEntry:deleted",
                },
            ],
        });
        expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)))
            .toMatchObject({
                zones: [
                    {
                        syncToken: "cursor-1",
                        desiredRecordTypes: ["PS_JournalEntry"],
                    },
                ],
            });
    });

    it("normalizes authentication failures", async () => {
        const handleAuthenticationRequired = vi.fn();
        const fetch = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValue(
                jsonResponse(
                    {
                        serverErrorCode:
                            "AUTHENTICATION_REQUIRED",
                        reason: "Sign in first.",
                    },
                    401
                )
            );
        const client = createCloudKitHttpClient({
            containerIdentifier: "iCloud.dev.party-stack.journal",
            environment: "development",
            apiToken: "api-token",
            tokenProvider: {
                getWebAuthToken: () => Promise.resolve(undefined),
                handleAuthenticationRequired,
            },
            fetch,
        });

        await expect(client.fetchZones("private")).rejects.toMatchObject({
            code: "authenticationRequired",
            message: "Sign in first.",
        });
        expect(handleAuthenticationRequired).toHaveBeenCalledOnce();
    });

    it("returns no record for an expected missing lookup", async () => {
        const fetch = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValue(
                jsonResponse({
                    records: [
                        {
                            recordName: "Action:first-run",
                            serverErrorCode: "NOT_FOUND",
                            reason: "Record does not exist.",
                        },
                    ],
                })
            );
        const client = createCloudKitHttpClient({
            containerIdentifier:
                "iCloud.com.partystack.journal",
            environment: "development",
            apiToken: "api-token",
            fetch,
        });

        await expect(
            client.fetchRecords({
                location,
                recordNames: ["Action:first-run"],
            })
        ).resolves.toEqual([]);
    });
});
