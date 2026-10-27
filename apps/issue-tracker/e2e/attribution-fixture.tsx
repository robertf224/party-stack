import { createLiveOntology, o, type OntologyIR } from "@party-stack/ontology";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { OntologyDevtoolsPanel } from "@party-stack/ontology-devtools";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import {
    memoryRuntimeFixture,
    defineRuntimeFixture,
    runtimeFixtureContext,
    asProvider,
} from "@party-stack/runtime/testing";
import { createLiveQueryCollection, eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { Effect } from "effect";
import { StrictMode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";

const ir: OntologyIR = {
    types: [],
    actionTypes: [{ name: "seed", displayName: "Seed", parameters: [], logic: [] }],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Note",
            displayName: "Note",
            pluralDisplayName: "Notes",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "image", displayName: "Image", type: o.optional({ type: o.attachment({}) }) },
            ],
        },
    ],
};
type Definition = { objectTypes: { Note: { id: string } }; actionTypes: {}; queryFunctionTypes: {} };
const backend = await Effect.runPromise(
    makeOwnedBackend({
        namespace: "fixture",
        ir,
        tables: await Effect.runPromise(Memory.make()),
        mutators: {
            seed: (tx) =>
                tx
                    .put("Note", { id: "one", image: { id: "preview" } })
                    .pipe(Effect.andThen(tx.put("Note", { id: "two" }))),
        },
    })
);
await Effect.runPromise(backend.applyAction({ id: "seed", name: "seed", parameters: {} }));
let loads = 0;
const fixtureRuntime = defineRuntimeFixture((owner, namespace) => ({
    ...memoryRuntimeFixture(owner, namespace),
    tables: Memory.make(),
}))("anonymous", "attribution-fixture");
const ontology = await createLiveOntology<Definition>({
    id: "attribution-fixture",
    ir,
    persistObjects: true,
    runtime: asProvider(() => fixtureRuntime),
    backend: () => ({
        name: "fixture",
        open: () =>
            Effect.succeed({
                ...backend,
                loadSubset: (query) =>
                    Effect.suspend(() => {
                        loads++;
                        return backend.loadSubset(query).pipe(
                            Effect.map((snapshot) => ({
                                ...snapshot,
                                pushdown: {
                                    source: "Fixture storage",
                                    predicates: query.query?.where
                                        ? [{ path: [], execution: "source" as const }]
                                        : [],
                                    sorting: "none" as const,
                                    pagination: "none" as const,
                                    rechecksFilter: false,
                                    native: {
                                        language: "json",
                                        text: JSON.stringify(query.query ?? {}, null, 2),
                                    },
                                },
                            }))
                        );
                    }),
            }),
    }),
});

await Effect.runPromise(ontology.storage!.syncOnce);
let loadPreview!: () => void;
const previewReady = new Promise<void>((resolve) => {
    loadPreview = resolve;
});
const previewSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#5a67d8"/></svg>';
const inspectedOntology = {
    ...ontology,
    attachments: {
        ...ontology.attachments,
        metadata: (async (attachment: { id: string }) => {
            await previewReady;
            return { ...attachment, name: "Preview image", size: previewSvg.length, type: "image/svg+xml" };
        }) as typeof ontology.attachments.metadata,
        blob: async () => new Blob([previewSvg], { type: "image/svg+xml" }),
    },
};

async function recordTraceFixtures() {
    const runtime = runtimeFixtureContext(fixtureRuntime).runtime;
    for (const name of ["Demand", "Traces"])
        await runtime.runPromise(
            Effect.exit(
                Effect.gen(function* () {
                    const span = yield* Effect.currentSpan;
                    span.event("replica.subscribed", BigInt(Date.now()) * 1_000_000n);
                    yield* Effect.interrupt;
                }).pipe(Effect.withSpan(name, { attributes: { activity: "subscription" } }))
            )
        );
    await runtime.runPromise(Effect.exit(Effect.interrupt.pipe(Effect.withSpan("Fixture.cancelled"))));
    await runtime.runPromise(
        Effect.exit(
            Effect.fail(new Error("Fixture connection refused")).pipe(Effect.withSpan("Fixture.failure"))
        )
    );
}

function NoteList({ id, instance }: { id: string; instance: string }) {
    const { data } = useLiveQuery(
        (q) =>
            q
                .from({ note: ontology.objects.Note })
                .where(({ note }) => eq(note.id, id))
                .select(({ note }) => ({ id: note.id, title: note.id })),
        [id]
    );
    return (
        <>
            <section
                data-testid={instance}
                style={{ minHeight: 90, padding: 20, background: "#edf4ff", margin: 20 }}
            >
                <h2>
                    {instance}: {id}
                </h2>
                <p>{data.length} notes</p>
            </section>
            {createPortal(
                <aside data-testid={`${instance}-portal`} style={{ margin: 20 }}>
                    Portal for {instance}
                </aside>,
                document.body
            )}
        </>
    );
}
const pooledSource = createLiveQueryCollection({
    query: (q) => q.from({ note: ontology.objects.Note }),
    startSync: true,
});
function PooledList({ id, instance }: { id: string; instance: string }) {
    const { data } = useLiveQuery({
        query: (q) => q.from({ note: pooledSource }).where(({ note }) => eq(note.id, id)),
    });
    return (
        <section data-testid={instance} style={{ minHeight: 90, padding: 20, margin: 20 }}>
            Pooled: {id}, {data.length} notes
        </section>
    );
}
function Fixture() {
    const [theme, setTheme] = useState<"dark" | "light">("dark");
    const [pooled, setPooled] = useState(false);
    const [second, showSecond] = useState(true);
    const [id, setId] = useState("one");
    const [count, setCount] = useState(loads);
    useEffect(() => {
        const timer = setInterval(() => setCount(loads), 50);
        return () => clearInterval(timer);
    }, []);
    return (
        <>
            <header style={{ position: "fixed", top: 0, background: "white", zIndex: 2 }}>
                <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
                    Use {theme === "dark" ? "light" : "dark"} theme
                </button>
                <button onClick={() => setPooled(true)}>Use pooled</button>
                <button onClick={loadPreview}>Load attachment preview</button>
                <button onClick={() => void recordTraceFixtures()}>Record trace fixtures</button>
                <button onClick={() => showSecond(false)}>Hide second</button>
                <button onClick={() => setId("two")}>Switch first</button>
                <output aria-label="Backend loads">{count}</output>
            </header>
            <div style={{ paddingTop: 1000, paddingBottom: 500 }}>
                {pooled ? (
                    <>
                        <PooledList id="one" instance="pooled-first" />
                        <PooledList id="two" instance="pooled-second" />
                    </>
                ) : (
                    <>
                        <NoteList id={id} instance="first" />
                        {second && <NoteList id="one" instance="second" />}
                        <NoteList id="two" instance="other" />
                    </>
                )}
            </div>
            <div
                data-testid="devtools-shell"
                style={{ position: "fixed", bottom: 0, left: 0, width: "100%", height: 330, zIndex: 3 }}
            >
                <OntologyDevtoolsPanel ontology={inspectedOntology} theme={theme} />
            </div>
        </>
    );
}
createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <Fixture />
    </StrictMode>
);
