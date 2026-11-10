import { createLiveOntology, createOntologyClient } from "@party-stack/ontology";
import { createAuthenticationClient } from "@party-stack/ontology/authentication";
import * as q from "@party-stack/ontology/query";
import { workerClient } from "@party-stack/ontology/worker";
import { queryOnce } from "@tanstack/db";
import { Effect } from "effect";
import * as WebRuntime from "../src/WebRuntime.js";
import type { PinStatus, LiveOntology } from "@party-stack/ontology";

// Only the SharedWorker may open persistent storage.
indexedDB.open = () => {
    throw new Error("A page attempted to open persistent tables.");
};
const namespace = new URL(location.href).searchParams.get("scope")!;
const client = await createOntologyClient(
    workerClient(
        () =>
            new SharedWorker(new URL("./multi-ontology-owner.worker.ts", import.meta.url), {
                name: namespace,
                type: "module",
            })
    )
);
const connections = await createAuthenticationClient({
    client,
    runtime: WebRuntime.webRuntime({ storage: "memory" }),
}).catch((error: unknown) => {
    Reflect.set(window, "serverFailure", error);
    return undefined;
});
const selected = async () => {
    const row = (await connections!.connections()).find((row) => row.userId === "alice");
    if (!row) throw new Error("Alice is not connected.");
    return row;
};
const open = async (ontologyId: string) =>
    createLiveOntology({
        client,
        ontology: `counters/${encodeURIComponent((await selected()).id)}/${ontologyId}`,
        runtime: WebRuntime.webRuntime({ storage: "memory" }),
        traceRecording: "buffer",
        writes: { defaultVisibility: "optimistic" },
    });
const command = (name: string, parameters: Record<string, unknown>) =>
    Effect.runPromise(
        Effect.scoped(
            Effect.flatMap(client.ontology("connect"), (value) =>
                value.backend.applyAction({ id: crypto.randomUUID(), name, parameters })
            )
        )
    );
const traceSubscriptions: (() => void)[] = [];
const tracingViews = new Map<string, LiveOntology>();
const pinWatches = new Map<
    string,
    { values: (PinStatus | undefined)[]; errors: unknown[]; close: () => Promise<void> }
>();
if (connections)
    Reflect.set(window, "serverTest", {
        signIn: (userId: string) => connections.attachExternalSession("fixture", userId),
        connections: async () =>
            (await connections.connections()).map((row) => ({
                userId: row.userId,
                state: { status: row.status },
            })),
        watchPin: async (ontologyId: string) => {
            const live = await open(ontologyId);
            const values: (PinStatus | undefined)[] = [];
            const errors: unknown[] = [];
            const stop = live.pins.subscribe(
                (value) => values.push(value),
                (error) => errors.push(String(error))
            );
            pinWatches.set(ontologyId, {
                values,
                errors,
                close: async () => {
                    stop();
                    await live.cleanup();
                },
            });
        },
        pinEvents: (ontologyId: string) => {
            const watch = pinWatches.get(ontologyId)!;
            return { values: watch.values, errors: watch.errors };
        },
        stopPinWatch: (ontologyId: string) => pinWatches.get(ontologyId)!.close(),
        setPin: async (ontologyId: string) => {
            const live = await open(ontologyId);
            try {
                await live.pins.set({
                    select: [
                        q.sub("counters", {
                            from: { source: { objectType: "Counter" }, binding: "c" },
                            select: [
                                q.selectField("id", q.field("c", "id")),
                                q.selectField("count", q.field("c", "count")),
                            ],
                        }),
                    ],
                });
            } finally {
                await live.cleanup();
            }
        },
        pin: async (ontologyId: string) => {
            const live = await open(ontologyId);
            try {
                return {
                    device: await live.pins.get(),
                    tab: await Effect.runPromise(live.replica.demand.pinStatus),
                };
            } finally {
                await live.cleanup();
            }
        },
        clearPin: async (ontologyId: string) => {
            const live = await open(ontologyId);
            try {
                await live.pins.clear();
            } finally {
                await live.cleanup();
            }
        },
        rows: async (ontologyId: string) => {
            const live = await open(ontologyId);
            try {
                return await queryOnce((q) => q.from({ counter: live.objects.Counter! }));
            } finally {
                await live.cleanup();
            }
        },
        increment: async (ontologyId: string) => {
            const live = await open(ontologyId);
            try {
                await live.actions.increment!({});
            } finally {
                await live.cleanup();
            }
        },
        startTracing: async (ontologyId: string) => {
            const live = await open(ontologyId);
            tracingViews.set(ontologyId, live);
            if (!live.traces || !live.diagnostics?.parent?.traces)
                throw new Error("Missing default worker diagnostics.");
            const traces = live.diagnostics.parent.traces;
            await new Promise<void>((resolve) => {
                traceSubscriptions.push(traces.subscribe(() => resolve()));
            });
        },
        traces: async (ontologyId: string) => {
            const live = tracingViews.get(ontologyId)!;
            return live.diagnostics?.parent?.traces?.getSnapshot();
        },
        clearTraces: async (ontologyId: string) => {
            const live = tracingViews.get(ontologyId)!;
            live.diagnostics?.parent?.traces?.clear();
            return live.diagnostics?.parent?.traces?.getSnapshot();
        },
        rejectedUnknownAction: async () => {
            try {
                await command("constructor", {});
                return "allowed";
            } catch (error) {
                return (error as { kind: string }).kind;
            }
        },
        upload: async () => {
            const live = await open("first-ontology");
            try {
                const result = await live.attachments.create(
                    new Blob([new Uint8Array(3 * 64 * 1024 + 7).fill(7)], {
                        type: "application/octet-stream",
                    }),
                    { eager: true }
                );
                await result.isMaterialized;
                return result.attachment;
            } finally {
                await live.cleanup();
            }
        },
        download: async (attachment: Parameters<LiveOntology["attachments"]["blob"]>[0]) => {
            const live = await open("first-ontology");
            try {
                const blob = await live.attachments.blob(attachment);
                const bytes = new Uint8Array(await blob.arrayBuffer());
                return { size: bytes.length, first: bytes[0], last: bytes.at(-1) };
            } finally {
                await live.cleanup();
            }
        },
        disconnect: async () => connections.signOut(await selected()),
        forget: async () => command("forgetAccount", { connectionId: (await selected()).id }),
        cleanup: async () => {
            for (const unsubscribe of traceSubscriptions) unsubscribe();
            await Promise.allSettled([...tracingViews.values()].map((view) => view.cleanup()));
            await Promise.allSettled([...pinWatches.values()].map((watch) => watch.close()));
            await connections.cleanup();
            await client.cleanup();
        },
    });
