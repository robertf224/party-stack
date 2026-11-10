import { executeAction } from "@party-stack/ontology-backend/actions";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { make } from "@party-stack/ontology-storage/memory/tables";
import { serveOntologyWorker } from "@party-stack/ontology/worker";
import { webRuntime } from "@party-stack/web-runtime";
import { Effect } from "effect";
import { ir } from "./ontology";
import type { OwnedBackendOptions } from "@party-stack/ontology-backend/owned";

const execute: OwnedBackendOptions["mutators"][string] = (tx, request) =>
    executeAction({ ir, tx, request }).pipe(Effect.map((result) => result.result));

serveOntologyWorker({
    enableRealtime: true,
    id: "website-playground",
    ir,
    runtime: webRuntime({ storage: "memory" }),
    backend: Effect.gen(function* () {
        const backend = yield* makeOwnedBackend({
            ir,
            namespace: "todos",
            tables: yield* make(),
            mutators: Object.fromEntries(ir.actionTypes.map((action) => [action.name, execute])),
        });
        for (const [index, title] of ["Pick the music", "Invite your friends", "Enjoy the party"].entries()) {
            yield* backend.applyAction({
                id: `seed-${index}`,
                name: "createTodo",
                parameters: { id: `todo-${index}`, title },
            });
        }
        return backend;
    }),
});
