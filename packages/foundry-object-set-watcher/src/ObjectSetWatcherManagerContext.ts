import { createContext } from "effection";
import { ObjectSetWatcherManager } from "./useObjectSetWatcherManager";

export const ObjectSetWatcherManagerContext = createContext<ObjectSetWatcherManager>(
    "@party-stack/foundry-object-set-watcher.ObjectSetManagerContext"
);
