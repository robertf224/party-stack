import { Table } from "@party-stack/ontology-storage/tables";
import { Schema } from "effect";
import { expect, test } from "vitest";
import { ClientStateCodec, ClientViewCodec } from "./protocol.js";
import type { ClientState } from "./protocol.js";

test("protocol codecs preserve storage values through an actual JSON round trip", () => {
    const value = {
        id: "one",
        nested: {
            bigint: 9007199254740993n,
            date: new Date("2026-10-20T12:00:00Z"),
            map: new Map([["one", new Set([1, 2])]]),
        },
    };
    const state: ClientState = {
        state: {
            sourceId: "source",
            revision: 1,
            definition: "{}",
            objects: [{ objectType: "Item", base: [{ key: "one", value }], overrides: [] }],
            pending: [],
            completed: [],
        },
        client: {
            client: { sourceId: "source", clientId: "client", resumeKey: "key" },
            connectionId: "connection",
            expiresAt: 100,
            acceptedThrough: 0,
            acknowledgedThrough: 0,
            deliveredThrough: 0,
            deliveredRevision: 1,
            appliedRevision: 0,
        },
    };
    const encoded = Schema.encodeSync(ClientStateCodec)(state);
    const decoded = Schema.decodeUnknownSync(ClientStateCodec)(JSON.parse(JSON.stringify(encoded)));
    const restored = decoded.state.objects[0]!.base[0]!.value;
    expect(restored).toEqual(value);
});

test("protocol decoding rejects invalid counters and unsupported query operators", () => {
    const encode = (input: unknown) => Table.make({ name: "wire" }).encode(input);
    const view = {
        generation: 1,
        selection: {
            subsets: [{ objectType: "Item", query: { where: { op: "rawSql", text: "DROP TABLE items" } } }],
            actionIds: [],
        },
    };
    expect(() => Schema.decodeUnknownSync(ClientViewCodec)(encode(view))).toThrow(/portable storage query/);
    expect(() => Schema.decodeUnknownSync(ClientViewCodec)(encode({ ...view, generation: -1 }))).toThrow(/./);
    expect(() => Schema.decodeUnknownSync(ClientViewCodec)("not an encoded value")).toThrow(
        /Invalid ontology protocol encoding/
    );
});
