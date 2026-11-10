import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { serveOntologyWorker } from "@party-stack/ontology/worker";
import { Effect } from "effect";
import { webRuntime } from "../src/index.js";
import { increment, ir } from "./replica-fixture.js";

serveOntologyWorker({
    enableRealtime: true,
    id: new URL(location.href).searchParams.get("scope")!,
    ir,
    runtime: webRuntime(),
    backend: Effect.gen(function* () {
        return yield* makeOwnedBackend({
            namespace: "authority",
            ir,
            tables: yield* Memory.make(),
            mutators: { increment },
        });
    }),
});
