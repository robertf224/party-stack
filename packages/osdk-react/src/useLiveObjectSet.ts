"use client";

import { useQueryClient } from "@tanstack/react-query";
import React from "react";
import { OntologyObservation } from "./ontology";
import { useOsdkContext } from "./OsdkContext";
import { updateAggregationQueries } from "./useAggregations";
import { updateObjectQueries } from "./useObject";
import { updateObjectsQueries } from "./useObjects";
import type { ObjectOrInterfaceDefinition, ObjectSet } from "@osdk/api";

export type LiveObjectSetState = { status: "connecting" | "connected" | "error"; error?: Error };

export function useLiveObjectSet<T extends ObjectOrInterfaceDefinition>(type: T): LiveObjectSetState {
    const { client } = useOsdkContext();
    const queryClient = useQueryClient();
    const [state, setState] = React.useState<LiveObjectSetState>({
        status: "connecting",
    });
    React.useEffect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const objectSet = client(type as any) as ObjectSet<T>;
        const subscription = objectSet.subscribe({
            onSuccessfulSubscription: () => {
                setState({ status: "connected" });
            },
            onError: (error) => {
                setState({ status: "error", error: error.error as Error });
            },
            onChange: (change) => {
                setState({ status: "connected" });
                const ontologyObservation: OntologyObservation = {
                    knownObjects:
                        change.state === "ADDED_OR_UPDATED"
                            ? [change.object.$as(change.object.$objectType)]
                            : [],
                    deletedObjects:
                        change.state === "REMOVED"
                            ? [
                                  {
                                      objectType: change.object.$objectType,
                                      primaryKey: change.object.$primaryKey,
                                  },
                              ]
                            : [],
                };
                updateObjectQueries(queryClient, ontologyObservation);
                updateObjectsQueries(queryClient, ontologyObservation);
                updateAggregationQueries(queryClient, ontologyObservation);
            },
        });
        return subscription.unsubscribe;
    }, [client, queryClient, type]);
    return state;
}
