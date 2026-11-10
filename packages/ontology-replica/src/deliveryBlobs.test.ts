import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { field, inArray } from "@party-stack/ontology-storage";
import { makeBlobStorage } from "@party-stack/ontology-storage/blobs";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { MemoryBlobBytesStore } from "@party-stack/runtime";
import { Effect, Exit, Scope, Stream } from "effect";
import { expect, test } from "vitest";
import { makeReplica, replicaStateSource } from "./testing.js";
import type { DeliveryChange, DeliveryRecord } from "@party-stack/ontology-backend/delivery";
import type { Query } from "@party-stack/ontology-storage";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Document",
            displayName: "Document",
            pluralDisplayName: "Documents",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "file", displayName: "File", type: o.attachment({}) },
            ],
        },
    ],
};

const base = (id: string, file: string): DeliveryRecord => ({
    kind: "base",
    objectType: "Document",
    key: id,
    value: { id, file: { id: file } },
});
const override = (id: string, file: string): DeliveryRecord => ({
    kind: "override",
    objectType: "Document",
    key: id,
    value: { deleted: false, value: { id, file: { id: file } } },
});

const fixture = Effect.fnUntraced(function* () {
    const tables = yield* Memory.make();
    const blobs = yield* makeBlobStorage({
        namespace: "delivery-blobs",
        tables,
        bytes: new MemoryBlobBytesStore(),
        attachmentBytesRetentionMode: "authoritative",
    });
    const retained: string[] = [];
    const parent = yield* makeReplica({
        namespace: "delivery-parent",
        tables: yield* Memory.make(),
        ir,
        startSync: false,
        execute: () => Effect.die("No action is expected."),
        backend: makeOntologyBackend({
            ir,
            name: "empty",
            sourceId: "empty",
            supportsIdempotency: false,
            queryFunction: () => Effect.void,
            loadSubset: () => Effect.succeed({ rows: [], complete: true }),
            applyAction: () => Effect.die("No action is expected."),
        }),
    });
    const source = replicaStateSource(parent);
    const child = yield* makeReplica({
        namespace: "delivery-child",
        ir,
        tables,
        source,
        startSync: false,
        execute: () => Effect.die("No action is expected."),
        blobs: {
            ...blobs,
            in: (tx) => ({
                ...blobs.in(tx),
                retain: (owner, ids, settings) => {
                    if (
                        settings?.group ===
                        JSON.stringify(["replica-row", "delivery-child", "base", "Document"])
                    )
                        retained.push(owner);
                    return blobs.in(tx).retain(owner, ids, settings);
                },
            }),
        },
    });
    // Acquire a real session and definition witness; frames below vary only the selected rows.
    const connection = yield* Scope.fork(yield* Effect.scope);
    const opened = yield* Scope.provide(child.openParentDelivery(source), connection);
    const pull = yield* Scope.provide(Stream.toPull(opened.subscription.frames), connection);
    const metadata = (yield* pull)[0]!.metadata!;
    yield* Scope.close(connection, Exit.void);
    let revision = metadata.revision;
    let streamId = "";
    let sequence = 0;
    const snapshot = (records: readonly DeliveryRecord[], query: Query = {}) => {
        streamId = crypto.randomUUID();
        sequence = 1;
        return child.receiveDelivery({
            streamId,
            sequence: 1,
            previous: 0,
            part: 0,
            kind: "snapshot",
            changes: records.map((record) => ({ kind: "put", record })),
            end: true,
            metadata: {
                ...metadata,
                revision: ++revision,
                coverage: [{ subset: { objectType: "Document", query }, complete: true }],
            },
        });
    };
    const patch = (changes: readonly DeliveryChange[], query: Query = {}) =>
        child.receiveDelivery({
            streamId,
            previous: sequence,
            sequence: ++sequence,
            part: 0,
            kind: "patch",
            changes,
            end: true,
            metadata: {
                ...metadata,
                revision: ++revision,
                coverage: [{ subset: { objectType: "Document", query }, complete: true }],
            },
        });
    return { child, blobs, retained, snapshot, patch };
});

test("snapshot repair retains final attachment roots after replacing inherited rows", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                for (const id of ["base-x", "inherited-y", "old-base", "outside"])
                    yield* f.blobs.stage(id, new Blob([id]));
                yield* f.snapshot([
                    base("a", "base-x"),
                    override("a", "inherited-y"),
                    base("b", "old-base"),
                    base("outside", "outside"),
                ]);
                expect(yield* f.blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(0);
                yield* f.blobs.stage("inherited-z", new Blob(["replacement"]));
                yield* f.snapshot([base("a", "base-x"), override("b", "inherited-z")], {
                    where: inArray(field("id"), ["a", "b"]),
                });
                expect(yield* f.child.get("Document", "a")).toMatchObject({
                    id: "a",
                    file: { id: "base-x" },
                });
                expect(yield* f.child.get("Document", "b")).toMatchObject({
                    id: "b",
                    file: { id: "inherited-z" },
                });
                expect(yield* f.child.get("Document", "outside")).toMatchObject({
                    id: "outside",
                    file: { id: "outside" },
                });
                expect(yield* f.blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(2);
                for (const id of ["base-x", "inherited-z", "outside"])
                    expect((yield* f.blobs.metadata(id))?.byteKey).toBeDefined();
                for (const id of ["inherited-y", "old-base"])
                    expect((yield* f.blobs.metadata(id))?.byteKey).toBeUndefined();
            })
        )
    );
});

test("a snapshot reconciles row attachment roots once across delivery scan pages", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                yield* f.blobs.stage("shared", new Blob(["shared bytes"]));
                const records = Array.from({ length: 131 }, (_, i) => base(`row-${i}`, "shared"));
                yield* f.snapshot(records);
                expect(f.retained).toHaveLength(records.length);
                expect(new Set(f.retained).size).toBe(records.length);
                expect(yield* f.blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(0);
            })
        )
    );
});

test("membership patches retain final attachment roots once and release a deleted row", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                for (const id of ["base-x", "inherited-y", "outside", "new-z"])
                    yield* f.blobs.stage(id, new Blob([id]));
                yield* f.snapshot([
                    base("a", "base-x"),
                    override("a", "inherited-y"),
                    base("outside", "outside"),
                ]);
                f.retained.length = 0;
                const query = { where: inArray(field("id"), ["a", "b"]) };
                yield* f.patch(
                    [
                        { kind: "put", record: base("b", "new-z") },
                        { kind: "remove", ref: { kind: "override", objectType: "Document", key: "a" } },
                        { kind: "remove", ref: { kind: "base", objectType: "Document", key: "outside" } },
                    ],
                    query
                );
                expect(f.retained).toHaveLength(2);
                expect(new Set(f.retained).size).toBe(2);
                expect(yield* f.child.get("Document", "a")).toMatchObject({ file: { id: "base-x" } });
                expect(yield* f.child.get("Document", "outside")).toMatchObject({ file: { id: "outside" } });
                expect(yield* f.blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(1);
                expect((yield* f.blobs.metadata("inherited-y"))?.byteKey).toBeUndefined();
                for (const id of ["base-x", "new-z", "outside"])
                    expect((yield* f.blobs.metadata(id))?.byteKey).toBeDefined();
                yield* f.patch(
                    [{ kind: "remove", ref: { kind: "base", objectType: "Document", key: "b" } }],
                    query
                );
                expect(yield* f.child.get("Document", "b")).toBeUndefined();
                expect(yield* f.blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(1);
                expect((yield* f.blobs.metadata("new-z"))?.byteKey).toBeUndefined();
            })
        )
    );
});
