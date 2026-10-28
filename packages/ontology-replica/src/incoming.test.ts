import { BackendError } from "@party-stack/ontology-backend";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { overlay } from "@party-stack/ontology-storage/overlay";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import { expect, expectTypeOf, test } from "vitest";
import { putIncomingRow } from "./incoming.js";
import { deliveryRecovery } from "./recovery.js";
import type { OntologyStorageError } from "@party-stack/ontology-storage";

test("malformed upstream rows fail in the typed Effect channel, never as form validation or a defect", async () => {
    expectTypeOf<Effect.Error<ReturnType<typeof putIncomingRow>>>().toEqualTypeOf<
        BackendError<"InvalidResponse"> | OntologyStorageError
    >();
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const base = Table.make<Record<string, unknown>>({ name: "base" });
                const view = overlay(base, { name: "overlay" });
                const invalid = tables.transaction((tx) =>
                    putIncomingRow(tx, view, "id", [], "one", { kind: "base", value: { id: "different" } })
                );
                const result = yield* Effect.result(invalid);
                expect(result).toMatchObject({
                    _tag: "Failure",
                    failure: { _tag: "BackendError", kind: "InvalidResponse" },
                });
                expect(
                    yield* invalid.pipe(
                        Effect.catchTag("BackendError", (error) => Effect.succeed(error.kind))
                    )
                ).toBe("InvalidResponse");
                expect(yield* tables.get(base, "one")).toBeUndefined();
            })
        )
    );
});

test.each([
    ["ViewReplaced", "selection"],
    ["HistoryExpired", "snapshot"],
    ["SessionExpired", "session"],
    ["SessionReplaced", "session"],
    ["Unavailable", "reconnect"],
    ["RateLimited", "reconnect"],
    ["InvalidResponse", "stop"],
    ["InvalidConfiguration", "stop"],
    ["SchemaMismatch", "stop"],
    ["SourceMismatch", "stop"],
    ["ResultExpired", "stop"],
] as const)("%s selects %s recovery without resetting the Replica itself", (kind, recovery) => {
    expect(
        deliveryRecovery(new BackendError({ operation: "test", kind, message: "test", retryable: true }))
    ).toBe(recovery);
});
