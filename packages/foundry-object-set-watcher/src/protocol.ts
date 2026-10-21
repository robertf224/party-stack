import type { ObjectSetSubscription, ObjectSetSubscriptionsMessage } from "./types.js";
import type {
    ObjectSetStreamSubscribeRequests,
    ObjectSetUpdate,
    StreamMessage,
} from "@osdk/foundry.ontologies";

export function bigIntToUuid(value: bigint): string {
    const decimalString = value.toString().padStart(32, "0");
    return `${decimalString.substring(0, 8)}-${decimalString.substring(8, 12)}-${decimalString.substring(12, 16)}-${decimalString.substring(16, 20)}-${decimalString.substring(20)}`;
}

export function uuidToBigInt(uuid: string): bigint {
    const decimalString = uuid.replace(/-/g, "");
    return BigInt(decimalString);
}

export function serializeRequest(requestId: bigint, request: readonly ObjectSetSubscription[]): string {
    return JSON.stringify({
        id: bigIntToUuid(requestId),
        // Strip out our internal subscription ids.
        requests: request.map(({ objectSet, propertySet, referenceSet }) => ({
            objectSet,
            propertySet,
            referenceSet,
        })),
    } satisfies ObjectSetStreamSubscribeRequests);
}

function filterChangeMessages(updates: ObjectSetUpdate[]): ObjectSetUpdate[] {
    const reversedUpdates = [...updates].reverse();
    const seen = new Set<string | number>();
    const filteredUpdates: ObjectSetUpdate[] = [];
    for (const update of reversedUpdates) {
        switch (update.type) {
            case "object": {
                const primaryKey = (update.object as unknown as { __primaryKey: string | number })
                    .__primaryKey;
                if (typeof primaryKey !== "string" && typeof primaryKey !== "number") {
                    filteredUpdates.push(update);
                    break;
                }
                if (!seen.has(primaryKey)) {
                    filteredUpdates.push(update);
                    seen.add(primaryKey);
                }
                break;
            }
            case "reference": {
                filteredUpdates.push(update);
                break;
            }
        }
    }
    return filteredUpdates;
}

export function convertSubscriptionMessage(
    message: StreamMessage,
    externalSubscriptionIdsToInternal: ReadonlyMap<string, string> | undefined
): ObjectSetSubscriptionsMessage | undefined {
    switch (message.type) {
        case "objectSetChanged": {
            const subscriptionId = externalSubscriptionIdsToInternal?.get(message.id);
            if (!subscriptionId) return undefined;
            return {
                type: "change",
                subscriptionId,
                updates: filterChangeMessages(message.updates),
            };
        }
        case "refreshObjectSet": {
            const subscriptionId = externalSubscriptionIdsToInternal?.get(message.id);
            if (!subscriptionId) return undefined;
            return {
                type: "refresh",
                subscriptionId,
                objectType: message.objectType,
            };
        }
        case "subscriptionClosed": {
            const subscriptionId = externalSubscriptionIdsToInternal?.get(message.id);
            if (!subscriptionId) return undefined;
            return {
                type: "state",
                updates: [{ subscriptionId, status: "closed" }],
            };
        }
        default:
            return undefined;
    }
}
