import { describe, expect, it } from "vite-plus/test";
import { convertSubscriptionMessage } from "./useObjectSetWatcherConnection.js";
import type { StreamMessage } from "@osdk/foundry.ontologies";

describe("convertSubscriptionMessage", () => {
    it.each([
        {
            type: "objectSetChanged",
            id: "released-subscription",
            updates: [],
        },
        {
            type: "refreshObjectSet",
            id: "released-subscription",
            objectType: "ExampleObject",
        },
        {
            type: "subscriptionClosed",
            id: "released-subscription",
        },
    ] as StreamMessage[])("ignores a late $type message after unsubscribe", (message) => {
        expect(convertSubscriptionMessage(message, new Map())).toBeUndefined();
    });
});
