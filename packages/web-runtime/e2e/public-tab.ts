import { createLiveOntology } from "@party-stack/ontology";
import { workerClient } from "@party-stack/ontology/worker";
import { queryOnce } from "@tanstack/db";
import { Effect } from "effect";
import { webRuntime } from "../src/index.js";

const scope = new URL(location.href).searchParams.get("scope")!;
const ontology = await createLiveOntology({
    client: workerClient(() => {
        const url = new URL("./public-owner.worker.ts", import.meta.url);
        url.searchParams.set("scope", scope);
        return new SharedWorker(url, { name: scope, type: "module" });
    }),
    runtime: webRuntime({ storage: "memory" }),
    writes: { defaultVisibility: "optimistic" },
});
let outcome: "idle" | "pending" | "confirmed" | { error: string } = "idle";
Reflect.set(window, "publicSetup", {
    rows: async () =>
        (await queryOnce((q) => q.from({ counter: ontology.objects.Counter! }))).map((row) => ({
            id: row.id,
            count: row.count,
        })),
    increment: () => {
        outcome = "pending";
        void ontology.actions.increment!({}).then(
            () => {
                outcome = "confirmed";
            },
            (error: unknown) => {
                outcome = { error: String(error) };
            }
        );
    },
    outcome: () => outcome,
    diagnostics: async () => ({
        status: await Effect.runPromise(ontology.replica.status.get),
        outbox: await Effect.runPromise(ontology.replica.outbox.entries),
    }),
    cleanup: () => ontology.cleanup(),
});
