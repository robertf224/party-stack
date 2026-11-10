import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import { BackendError } from "@party-stack/ontology-backend";
import { DeliveryFrameCodec } from "@party-stack/ontology-backend/delivery";
import { protocolValueCodec } from "@party-stack/ontology-backend/protocol";
import { makeOntologyWorkerClient } from "@party-stack/ontology-server/rpc/worker";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Queue, Schema, Stream } from "effect";
import { makeReplicaKernel } from "../../ontology-replica/lib/engine.js";
import {
    count,
    document as queryDocument,
    execute,
    ir,
    properties,
    row,
    subsets,
    targetId,
} from "./query-path-fixture.js";
import type { DeliveryFrame } from "@party-stack/ontology-backend/delivery";
import type { ClientView, OntologySource } from "@party-stack/ontology-backend/protocol";

const encodedValue = Schema.encodeSync(protocolValueCodec(Schema.Unknown));
const encodedFrame = Schema.encodeSync(DeliveryFrameCodec);
const bytes = (text: string) => new TextEncoder().encode(text).length;
const canonical = (rows: readonly Record<string, unknown>[]) =>
    rows
        .map((value) => Object.fromEntries(properties.map((name) => [name, value[name]])))
        .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
const union = (result: Record<string, unknown>) =>
    canonical([
        ...new Map(
            Object.values(result).flatMap((rows) =>
                (rows as Record<string, unknown>[]).map((value) => [String(value.id), value] as const)
            )
        ).values(),
    ]);
const assert = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
};
const scope = new URL(location.href).searchParams.get("scope")!;
const url = new URL("./query-path-owner.worker.ts", import.meta.url);
url.searchParams.set("scope", scope);
const worker = new SharedWorker(url, { name: scope, type: "module" });
const control = worker.port;
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
let resolveReady: (value: unknown) => void;
let rejectReady: (value: unknown) => void;
const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
});
worker.onerror = (event) => rejectReady(new Error(event.message));
control.onmessage = (event) => {
    if (event.data.readyError) rejectReady(new Error(event.data.readyError));
    else if (event.data.ready) resolveReady(event.data);
    else {
        const entry = pending.get(event.data.id);
        if (!entry) return;
        pending.delete(event.data.id);
        if (event.data.error) entry.reject(new Error(event.data.error));
        else entry.resolve(event.data.value);
    }
};
control.start();
const channel = new MessageChannel();
control.postMessage({ kind: "rpc" }, [channel.port1]);
const command = (name: string) =>
    new Promise<unknown>((resolve, reject) => {
        const id = crypto.randomUUID();
        pending.set(id, { resolve, reject });
        control.postMessage({ id, command: name });
    });
export async function runQueryPathBenchmark() {
    const setup = await ready;
    const result = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const server = yield* makeOntologyWorkerClient().pipe(
                    Effect.provide(BrowserWorker.layer(() => channel.port2))
                );
                const client = yield* server.ontology();
                if (client.replication.kind !== "speculative")
                    throw new Error("Expected speculative parent.");
                const nativeSource = client.replication.source;
                let selected: ClientView | undefined;
                const source: OntologySource = {
                    ...nativeSource,
                    subscribe: (session, view, policy, resume) => {
                        selected = view;
                        return nativeSource.subscribe!(session, view, policy, resume);
                    },
                };
                const child = yield* makeReplicaKernel({
                    namespace: "query-path-memory-child",
                    ir,
                    tables: yield* Memory.make(),
                    source,
                    execute,
                    startSync: false,
                    objectCacheGc: false,
                });
                for (const subset of subsets) yield* child.demand(subset);
                yield* child.retainActions(["pending-edit"]);
                // Watch invalidations are subscribed before the initial finite read.
                const notifications = yield* Queue.sliding<void>(1);
                const watch = client.backend.watchSubset?.({
                    from: { source: { objectType: "Note" }, binding: "row" },
                });
                if (!watch) throw new Error("Benchmark backend does not support subset watches.");
                const changes = yield* watch;
                yield* changes.pipe(
                    Stream.runForEach(() => Queue.offer(notifications, undefined)),
                    Effect.forkScoped({ startImmediately: true })
                );
                const read = Effect.fnUntraced(function* () {
                    const began = performance.now();
                    const value = yield* client.backend.query(queryDocument);
                    return { value: value as Record<string, unknown>, rpcMs: performance.now() - began };
                });
                yield* Effect.promise(() => command("metrics"));
                const initialRead = yield* read();
                const openedAt = performance.now();
                const opened = yield* child.openParentDelivery(source);
                const openSelectionMs = performance.now() - openedAt;
                const pull = yield* Stream.toPull(opened.subscription.frames);
                const deliver = Effect.fnUntraced(function* () {
                    const firstAt = performance.now();
                    const frames: DeliveryFrame[] = [];
                    let ended = false;
                    while (!ended)
                        for (const frame of yield* pull) {
                            frames.push(frame);
                            if (frame.end) ended = true;
                        }
                    const receiveMs = performance.now() - firstAt;
                    const installAt = performance.now();
                    const results = yield* Effect.forEach(frames, (frame) =>
                        child.receiveDelivery(frame, opened.generation)
                    );
                    const installed = results.find((value) => value !== undefined)!;
                    assert(installed, "No complete delivery installed.");
                    const installMs = performance.now() - installAt;
                    const ackAt = performance.now();
                    if (installed.metadata.client)
                        yield* source.acknowledge(
                            opened.session ?? installed.metadata.client,
                            installed.metadata.revision,
                            installed.metadata.client.deliveredThrough,
                            installed.metadata.generation
                        );
                    yield* opened.subscription.acknowledge(installed.position);
                    const ackMs = performance.now() - ackAt;
                    return { frames, receiveMs, installMs, ackMs };
                });
                const initialDelivery = yield* deliver();
                const initialRows = canonical((yield* child.loadSubset("Note")).map((entry) => entry.value));
                assert(initialRows.length === count, "Wrong initial union size.");
                assert(
                    JSON.stringify(initialRows) === JSON.stringify(union(initialRead.value)),
                    "Initial read and delivery unions differ."
                );
                const initialWorker = yield* Effect.promise(() => command("metrics"));
                yield* Queue.clear(notifications);
                const acceptedAt = performance.now();
                yield* source.accept!({
                    session: opened.session!,
                    sequence: 1,
                    invocation: {
                        id: "pending-edit",
                        name: "edit",
                        parameters: { id: targetId, bodyMarkdown: "Edited but not executed upstream." },
                    },
                    optimistic: true,
                    view: selected!,
                });
                const acceptMs = performance.now() - acceptedAt;
                const notifiedAt = performance.now();
                yield* Queue.take(notifications);
                const notificationWaitMs = performance.now() - notifiedAt;
                const editedRead = yield* read();
                const editedDelivery = yield* deliver();
                const editedRows = canonical((yield* child.loadSubset("Note")).map((entry) => entry.value));
                assert(
                    JSON.stringify(editedRows) === JSON.stringify(union(editedRead.value)),
                    "Edited read and delivery unions differ."
                );
                const visible = yield* child.get("Note", targetId);
                const confirmed = yield* child.confirmed.get("Note", targetId);
                const summary = (yield* Effect.promise(() => command("summary"))) as {
                    pending: { id: string; state: string }[];
                    authoritative: Record<string, unknown>;
                };
                assert(
                    visible?.bodyMarkdown === "Edited but not executed upstream.",
                    "Parent prediction missing."
                );
                assert(
                    confirmed?.bodyMarkdown === row(0).bodyMarkdown,
                    "Prediction was flattened into committed base."
                );
                assert(
                    summary.authoritative.bodyMarkdown === row(0).bodyMarkdown,
                    "Authority unexpectedly executed action."
                );
                assert(
                    summary.pending.some((entry) => entry.id === "pending-edit" && entry.state === "queued"),
                    "Accepted action was lost or executed."
                );
                const editedWorker = yield* Effect.promise(() => command("metrics"));
                const payload = (readResult: typeof initialRead, delivery: typeof initialDelivery) => {
                    const began = performance.now();
                    const readBytes = bytes(encodedValue(readResult.value));
                    const deliveryBytes = delivery.frames.reduce(
                        (sum, frame) => sum + bytes(encodedFrame(frame)),
                        0
                    );
                    return {
                        readBytes,
                        deliveryBytes,
                        diagnosticEncodingMs: performance.now() - began,
                        readReturnedRows: Object.values(readResult.value).reduce<number>(
                            (sum, rows) => sum + (rows as unknown[]).length,
                            0
                        ),
                        deduplicatedUnionRows: union(readResult.value).length,
                        deliveryChanges: delivery.frames.flatMap((frame) => frame.changes).length,
                        deliveryFrames: delivery.frames.length,
                    };
                };
                return {
                    setup,
                    fixture: {
                        rows: count,
                        subsets,
                        phaseOrder:
                            "finite-read then incremental-delivery over the same unchanged worker state",
                        storage: "one IndexedDB parent; memory authority and child",
                        baseline: "test-only composed-visible finite read, not a committed writing backend",
                    },
                    initial: {
                        readRpcMs: initialRead.rpcMs,
                        openSelectionMs,
                        delivery: {
                            receiveMs: initialDelivery.receiveMs,
                            installMs: initialDelivery.installMs,
                            ackMs: initialDelivery.ackMs,
                        },
                        payload: payload(initialRead, initialDelivery),
                        worker: initialWorker,
                    },
                    singleAcceptedEdit: {
                        acceptMs,
                        notificationWaitMs,
                        readRpcMs: editedRead.rpcMs,
                        delivery: {
                            receiveMs: editedDelivery.receiveMs,
                            installMs: editedDelivery.installMs,
                            ackMs: editedDelivery.ackMs,
                        },
                        payload: payload(editedRead, editedDelivery),
                        worker: editedWorker,
                    },
                    assertions: {
                        matchedInitialUnion: true,
                        matchedEditedUnion: true,
                        acceptedUnexecuted: true,
                        speculativeBaselinePreserved: true,
                    },
                };
            })
        )
    );
    await command("close");
    control.close();
    return result;
}

void runQueryPathBenchmark().then(
    (result) => {
        document.getElementById("result")!.textContent = JSON.stringify(result);
    },
    (error: unknown) => {
        document.getElementById("result")!.textContent = JSON.stringify({
            error:
                error instanceof BackendError ? { kind: error.kind, message: error.message } : String(error),
        });
    }
);
