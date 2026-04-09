import { ObjectSet } from "@osdk/foundry.ontologies";
import { Stream } from "effection";
import { ObjectSetWatcherManagerContext } from "./ObjectSetWatcherManagerContext";
import { ObjectSetSubscriptionMessage } from "./types";
import { ObjectSetWatcherManager } from "./useObjectSetWatcherManager";

export function* useObjectSetWatcherSubscription(
    objectSet: ObjectSet,
    manager?: ObjectSetWatcherManager
): Stream<ObjectSetSubscriptionMessage, void> {
    manager = manager ?? (yield* ObjectSetWatcherManagerContext.expect());
    return yield* manager.observe(objectSet);
}
