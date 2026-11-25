import { Effect, Stream, SubscriptionRef } from "effect";
import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BackendError } from "../../ontology-backend/lib/index.js";
import { o } from "../../ontology-spec/lib/index.js";
import { OntologyProvider, useOntology } from "../src/index.js";
import type { OntologyClient, OntologyServerClient } from "@party-stack/ontology";

type Status = { status: "retained" | "current" | "incompatible"; refreshing: boolean; error?: BackendError };
const objectType = (name: string) => ({
    name,
    displayName: name,
    pluralDisplayName: name,
    primaryKey: "id",
    properties: [{ name: "id", displayName: "Id", type: o.string({}) }],
});
const definitions = [
    { types: [], objectTypes: [objectType("Item")], linkTypes: [], actionTypes: [], queryFunctionTypes: [] },
    {
        types: [],
        objectTypes: [objectType("Item"), objectType("Other")],
        linkTypes: [],
        actionTypes: [],
        queryFunctionTypes: [],
    },
];
const events: string[] = [];
let opens = 0;
const status = Effect.runSync(SubscriptionRef.make<Status>({ status: "current", refreshing: false }));
const client: OntologyServerClient = {
    ontology: () =>
        Effect.gen(function* () {
            const opened = ++opens;
            events.push(`open ${opened}`);
            yield* Effect.addFinalizer(() => Effect.sync(() => events.push(`close ${opened}`)));
            const ir = definitions[Math.min(opened, 2) - 1]!;
            return {
                ir,
                context: {},
                sourceId: "reopen",
                backend: {
                    name: "reopen-fixture",
                    sourceId: "reopen",
                    supportsIdempotency: true,
                    loadSubset: () => Effect.succeed({ rows: [], complete: true }),
                    query: () => Effect.succeed({}),
                    queryFunction: () => Effect.succeed(undefined),
                    applyAction: (action: { id: string }) =>
                        Effect.succeed({
                            operationId: action.id,
                            outcome: "committed" as const,
                            affected: [],
                        }),
                },
                replication: { kind: "committed" as const },
                operations: {},
                // Only the first view sees the server's definition change.
                definition: {
                    get: SubscriptionRef.get(status),
                    changes:
                        opened === 1
                            ? SubscriptionRef.changes(status)
                            : Stream.concat(
                                  Stream.make({ status: "current", refreshing: false }),
                                  Stream.never
                              ),
                    refresh: Effect.die("unused"),
                },
            } as unknown as OntologyClient;
        }),
};

function Consumer() {
    const ontology = useOntology();
    return <span data-testid="types">{ontology.ir.objectTypes.map((type) => type.name).join(",")}</span>;
}
createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <Suspense fallback={<span data-testid="pending">Opening</span>}>
            <OntologyProvider client={client}>
                <Consumer />
            </OntologyProvider>
        </Suspense>
    </StrictMode>
);
Reflect.set(window, "fixture", {
    events: () => [...events],
    stale: () =>
        Effect.runSync(
            SubscriptionRef.set(status, {
                status: "incompatible",
                refreshing: false,
                error: new BackendError({
                    operation: "fixture",
                    kind: "SchemaMismatch",
                    retryable: false,
                    message: "The definition changed.",
                }),
            })
        ),
});
