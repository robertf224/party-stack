import { ObjectSetStreamSubscribeRequest, ObjectSetUpdate } from "@osdk/foundry.ontologies";

export interface ObjectSetSubscription extends ObjectSetStreamSubscribeRequest {
    id: string;
}

export type ObjectSetSubscriptionStateUpdateStatus = "open" | "closed" | "qos" | "error";

export interface ObjectSetSubscriptionsStateUpdateMessage {
    subscriptionId: string;
    status: ObjectSetSubscriptionStateUpdateStatus;
}

export interface ObjectSetSubscriptionsStateUpdateMessages {
    type: "state";
    updates: ObjectSetSubscriptionsStateUpdateMessage[];
}

export interface ObjectSetSubscriptionsChangeMessage {
    type: "change";
    subscriptionId: string;
    updates: ObjectSetUpdate[];
}

export interface ObjectSetSubscriptionsRefreshMessage {
    type: "refresh";
    subscriptionId: string;
    objectType: string;
}

export type ObjectSetSubscriptionsMessage =
    | ObjectSetSubscriptionsStateUpdateMessages
    | ObjectSetSubscriptionsChangeMessage
    | ObjectSetSubscriptionsRefreshMessage;

export type ObjectSetSubscriptionMessage =
    | { type: "change"; updates: ObjectSetUpdate[] }
    | { type: "refresh"; objectType: string }
    | { type: "state"; status: ObjectSetSubscriptionStateUpdateStatus };
