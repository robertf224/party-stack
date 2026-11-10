import { workerClient } from "@party-stack/ontology/worker";
import { webRuntime } from "@party-stack/web-runtime";
import { notesMutators } from "./mutators";

export const notesOptions = {
    client: workerClient(
        () =>
            new SharedWorker(new URL("./ontology.worker.ts", import.meta.url), {
                name: "party-notes-device-v2",
                type: "module",
            })
    ),
    ontology: "notes",
    runtime: webRuntime({ storage: "memory" }),
    writes: { defaultVisibility: "optimistic", mutators: notesMutators },
    parent: { label: "Device", location: "Shared worker" },
    demand: { idleRetentionMs: 30_000 },
    traceRecording: "buffer",
} as const;
