import { runMain } from "@effect/platform-browser/BrowserRuntime";
import { run as runOpfsWorker } from "@effect/sql-sqlite-wasm/OpfsWorker";
import { Effect, Schema } from "effect";

const Bootstrap = Schema.Struct({
    kind: Schema.Literal("notes-sqlite-host"),
    port: Schema.instanceOf(MessagePort),
});
const bootstrap = Effect.callback<MessagePort, Schema.SchemaError>((resume) => {
    const listener = (event: MessageEvent) =>
        resume(Schema.decodeUnknownEffect(Bootstrap)(event.data).pipe(Effect.map((value) => value.port)));
    globalThis.addEventListener("message", listener);
    return Effect.sync(() => globalThis.removeEventListener("message", listener));
});
bootstrap.pipe(
    Effect.flatMap((port) => runOpfsWorker({ port, dbName: "party-notes-storage-benchmark.sqlite" })),
    runMain
);
