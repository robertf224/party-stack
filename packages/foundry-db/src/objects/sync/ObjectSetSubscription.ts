import { ObjectSetStreamSubscribeRequest, ObjectSetUpdate } from "@osdk/foundry.ontologies";

export interface ObjectSetSubscription extends ObjectSetStreamSubscribeRequest {
    id: string;
}

export interface ObjectSetSubscriptionStateUpdateMessage {
    subscriptionId: string;
    status: "open" | "closed" | "qos" | "error";
}

export interface ObjectSetSubscriptionStateUpdateMessages {
    type: "state";
    updates: ObjectSetSubscriptionStateUpdateMessage[];
}

export interface ObjectSetSubscriptionChangeMessage {
    type: "change";
    subscriptionId: string;
    updates: ObjectSetUpdate[];
}

export interface ObjectSetSubscriptionRefreshMessage {
    type: "refresh";
    subscriptionId: string;
    objectType: string;
}

export type ObjectSetSubscriptionMessage =
    | ObjectSetSubscriptionStateUpdateMessages
    | ObjectSetSubscriptionChangeMessage
    | ObjectSetSubscriptionRefreshMessage;
