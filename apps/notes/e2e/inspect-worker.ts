import { field, inArray } from "@party-stack/ontology-storage";
import { workerClient } from "@party-stack/ontology/worker";
import { Effect } from "effect";

/** Read-only diagnostics over a separate port to the same test-context worker. */
export function inspectWorker(url: string, noteIds?: readonly string[]) {
    return Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const server = yield* workerClient(
                    () =>
                        new SharedWorker(url, {
                            name: "party-notes-device-v2",
                            type: "module",
                        })
                );
                const client = yield* server.ontology("notes");
                const monitor = client.operations.replicaMonitor;
                const status = yield* Effect.callback<ReturnType<typeof monitor.getSnapshot>>((resume) => {
                    const changed = () => {
                        const value = monitor.getSnapshot();
                        if (value.status || value.error) resume(Effect.succeed(value));
                    };
                    const stop = monitor.subscribe(changed);
                    changed();
                    return Effect.sync(stop);
                });
                const store = client.operations.traces;
                const traces = yield* Effect.callback<ReturnType<typeof store.getSnapshot>>((resume) => {
                    const stop = store.subscribe(() => resume(Effect.succeed(store.getSnapshot())));
                    return Effect.sync(stop);
                }).pipe(Effect.timeoutOrElse({ duration: 5_000, orElse: () => Effect.succeed([]) }));
                const source =
                    client.replication.kind === "speculative" ? client.replication.source : undefined;
                const selected =
                    source && noteIds
                        ? yield* source.read(yield* source.openClient(), {
                              generation: 1,
                              selection: {
                                  subsets: [
                                      { objectType: "Note", query: { where: inArray(field("id"), noteIds) } },
                                  ],
                                  actionIds: [],
                                  inspectActions: true,
                              },
                          })
                        : undefined;
                return { status, traces, selected };
            })
        )
    );
}
