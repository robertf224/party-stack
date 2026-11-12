// Startup benchmark for a large native host definition.
// Usage: node bench/hostOpen.mjs <ir.json>
// Models the mobile device owner: a factory route retains its definition, the
// UI opens a memory view through localClient, and a second server instance over
// the same storage models an app restart.
import { readFileSync } from "node:fs";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { makeOntologyServer } from "@party-stack/ontology-server";
import { OntologyIRSchema } from "@party-stack/ontology-spec/effect";
import { contextPartition } from "@party-stack/ontology-spec/utils";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { MemoryRuntime, Runtimes } from "@party-stack/runtime";
import { Effect, Exit, Layer, Schema, Scope, Tracer } from "effect";
import { createOntologyClient } from "../lib/client.js";
import { createLiveOntology } from "../lib/live/LiveOntology.js";
import { localClient } from "../lib/local.js";

const spans = new Map();
const tracer = Tracer.make({
    ...Tracer.nativeTracer,
    span(options) {
        const span = Tracer.nativeTracer.span(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
            end(endTime, exit);
            const ms = Number(endTime - options.startTime) / 1e6;
            const total = spans.get(options.name) ?? { n: 0, ms: 0 };
            total.n++;
            total.ms += ms;
            spans.set(options.name, total);
        };
        return span;
    },
});
const now = () => performance.now();
const raw = JSON.parse(readFileSync(process.argv[2], "utf8"));
let started = now();
const ir = Schema.decodeUnknownSync(OntologyIRSchema)(raw);
console.log("decode IR", (now() - started).toFixed(0), "ms");
const context = { userId: "bench-user" };
const platformScope = Effect.runSync(Scope.make());
const platform = await Effect.runPromise(
    Layer.buildWithScope(Runtimes.layer(MemoryRuntime.layer), platformScope)
);
// Keep the memory drivers alive between server instances, like durable storage.
await Effect.runPromise(
    Effect.gen(function* () {
        const runtimes = yield* Runtimes;
        yield* runtimes.acquire({ owner: "replica-registry", namespace: "default" });
        yield* runtimes.acquire({ owner: contextPartition(ir, context), namespace: "host" });
    }).pipe(Effect.provideContext(platform), Scope.provide(platformScope))
);
const backendScope = Effect.runSync(Scope.make());
const backend = await Effect.runPromise(
    Effect.gen(function* () {
        return yield* makeOwnedBackend({
            namespace: "bench",
            ir,
            tables: yield* Memory.make(),
            mutators: {},
        });
    }).pipe(Scope.provide(backendScope))
);
const server = makeOntologyServer({
    enableRealtime: true,
    replicas: {},
    routes: {
        host: (_params, route) =>
            Effect.gen(function* () {
                const definition = yield* route.definition({ context, load: Effect.succeed(ir) });
                return {
                    kind: "replica",
                    ir: definition,
                    context,
                    backend,
                    dangerouslyAllowInternalAccess: true,
                };
            }),
    },
}).pipe(Effect.provideContext(platform), Effect.withTracer(tracer));

for (const run of ["first launch", "restart"]) {
    const client = await createOntologyClient(localClient(server).pipe(Effect.withTracer(tracer)));
    for (const view of ["view", "second view"]) {
        spans.clear();
        started = now();
        const live = await createLiveOntology({ client, ontology: "host" });
        console.log(`${run} ${view}: ${(now() - started).toFixed(0)} ms`);
        if (process.env.SPANS)
            for (const [name, s] of [...spans].sort((a, b) => b[1].ms - a[1].ms).slice(0, 12))
                console.log(`   ${name.padEnd(36)} n=${s.n} total=${s.ms.toFixed(0)}`);
        await live.cleanup();
    }
    await client.cleanup();
}
await Effect.runPromise(Scope.close(backendScope, Exit.void));
await Effect.runPromise(Scope.close(platformScope, Exit.void));
