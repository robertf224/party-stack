import { createMetaLiveOntology } from "@party-stack/ontology";
import { eq, queryOnce } from "@tanstack/db";
import { describe, expect, it, vi } from "vite-plus/test";
import { createSalesforceMetaOntologyBackendAdapter } from "./createSalesforceMetaOntologyBackendAdapter.js";

describe("Salesforce QueryFunctionType metadata queries", () => {
    it("loads whitelisted reads and excludes mutating standard actions", async () => {
        const describeStandardAction = vi
            .fn()
            .mockResolvedValue({
                name: "getConversationTranscript",
                label: "Get Conversation Transcript",
                inputs: [{ name: "recordId", type: "STRING", required: true }],
                outputs: [{ name: "unformattedTextTranscript", type: "STRING" }],
            });
        const meta = await createMetaLiveOntology({
            backend: () =>
                createSalesforceMetaOntologyBackendAdapter({ client: { describeStandardAction } as never }),
            persistObjects: false,
        });

        try {
            const reads = await queryOnce((q) =>
                q
                    .from({ QueryFunctionType: meta.objects.QueryFunctionType })
                    .where(({ QueryFunctionType }) => eq(QueryFunctionType.name, "getConversationTranscript"))
            );

            expect(describeStandardAction).toHaveBeenCalledExactlyOnceWith("getConversationTranscript");
            expect(reads[0]).toMatchObject({
                name: "getConversationTranscript",
                parameters: [{ name: "recordId" }],
                returnType: { kind: "struct", value: { fields: [{ name: "unformattedTextTranscript" }] } },
            });

            describeStandardAction.mockClear();
            const mutations = await queryOnce((q) =>
                q
                    .from({ QueryFunctionType: meta.objects.QueryFunctionType })
                    .where(({ QueryFunctionType }) => eq(QueryFunctionType.name, "confirmSalesMeeting"))
            );

            expect(mutations).toEqual([]);
            expect(describeStandardAction).not.toHaveBeenCalled();
        } finally {
            await meta.cleanup();
        }
    });
});
