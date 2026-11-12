import { ObjectSetStreamSubscribeRequest, ObjectSetUpdate } from "@osdk/foundry.ontologies";

export interface ObjectSetSubscription extends ObjectSetStreamSubscribeRequest {
    id: string;
}

export type ObjectSetSubscriptionStateUpdateStatus = "open" | "closed" | "qos" | "error";

/** Why a subscription is not open, as reported by Foundry. Raw payloads may contain
 * provider error arguments; keep them out of user-facing messages. */
export interface ObjectSetSubscriptionStateReason {
    /** Short summary, such as Foundry error names or a closure reason. */
    message: string;
    /** The provider's error or closure payload. */
    detail?: unknown;
}

export interface ObjectSetSubscriptionsStateUpdateMessage {
    subscriptionId: string;
    status: ObjectSetSubscriptionStateUpdateStatus;
    reason?: ObjectSetSubscriptionStateReason;
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
    | {
          type: "state";
          status: ObjectSetSubscriptionStateUpdateStatus;
          reason?: ObjectSetSubscriptionStateReason;
      };
