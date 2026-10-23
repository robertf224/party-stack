import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { formatGeneratedFile } from "../cli/format.js";
import { o } from "../ir/generated/builders.js";
import selfSchema from "../ir/schema.js";
import { generateEffectSchemas } from "./schemas.js";
import { generateTypes } from "./types.js";
import type { OntologyIR, TypeDef } from "../ir/generated/types.js";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const directories: string[] = [];
afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const field = (name: string, type: TypeDef) => ({ name, displayName: name, type });
const empty: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
};

// Execute and typecheck the emitted files as a consumer would, including recursive annotations.
async function checkGenerated(ir: OntologyIR, script: string) {
    const root = fileURLToPath(new URL("../../temp", import.meta.url));
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(join(root, "effect-codegen-"));
    directories.push(cwd);
    for (const [name, source] of Object.entries({
        "types.ts": generateTypes(ir),
        "effect.ts": generateEffectSchemas(ir),
        "effect-types.ts": generateTypes(ir, {
            valuesImportPath: "@party-stack/ontology-spec/effect/values",
        }),
        "consumer.ts": script,
    }))
        await writeFile(join(cwd, name), await formatGeneratedFile(name, source));
    await writeFile(join(cwd, "ontology.json"), JSON.stringify(ir));
    try {
        await execute(
            process.execPath,
            [
                join(dirname(require.resolve("typescript/package.json")), "bin/tsc"),
                "--ignoreConfig",
                "--noEmit",
                "--strict",
                "--skipLibCheck",
                "--types",
                "node",
                "--target",
                "es2022",
                "--module",
                "nodenext",
                "consumer.ts",
            ],
            { cwd }
        );
        await execute(process.execPath, ["--import", require.resolve("tsx"), "consumer.ts"], { cwd });
    } catch (error) {
        const output = error as Error & { stdout?: string; stderr?: string };
        throw new Error(`${output.message}\n${output.stdout ?? ""}\n${output.stderr ?? ""}`, {
            cause: error,
        });
    }
    return readFile(join(cwd, "effect.ts"), "utf8");
}

describe("Effect schema generation", () => {
    it("validates plain ontology objects and derives nested Temporal JSON codecs", async () => {
        const ir: OntologyIR = {
            ...empty,
            types: [
                {
                    name: "NestedOutcome",
                    type: o.result({
                        okType: o.result({ okType: o.date({}), errType: o.integer({}) }),
                        errType: o.timestamp({}),
                    }),
                },
                {
                    name: "Node",
                    type: o.struct({
                        fields: [
                            field("label", o.string({})),
                            field("children", o.list({ elementType: o.ref({ name: "Node" }) })),
                        ],
                    }),
                },
                {
                    name: "Status",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [{ value: "open" }, { value: 'closed"\\\n' }],
                        }),
                    }),
                },
            ],
            objectTypes: [
                {
                    name: "Entry",
                    displayName: "Entry",
                    pluralDisplayName: "Entries",
                    primaryKey: "id",
                    properties: [
                        field("id", o.integer({})),
                        field("parent", o.objectReference({ objectType: "Entry" })),
                        field("status", o.ref({ name: "Status" })),
                        field(
                            "name",
                            o.string({ constraint: o.StringConstraint.regex({ regex: "^[a-z]+$" }) })
                        ),
                        field("createdAt", o.timestamp({})),
                        field("dates", o.map({ keyType: o.string({}), valueType: o.date({}) })),
                        field("tree", o.ref({ name: "Node" })),
                        field("result", o.result({ okType: o.timestamp({}), errType: o.string({}) })),
                        field(
                            "photo",
                            o.attachment({
                                constraint: {
                                    content: o.AttachmentContentConstraint.image({
                                        mediaTypes: ["image/png"],
                                    }),
                                },
                            })
                        ),
                        field("note", o.optional({ type: o.string({}) })),
                        field("position", o.geopoint({})),
                        field("score", o.float({})),
                        field("rating", o.double({})),
                        field("active", o.boolean({})),
                        field("metadata", o.unknown({})),
                        field(
                            "secret",
                            o.encrypted({
                                type: o.result({ okType: o.timestamp({}), errType: o.string({}) }),
                            })
                        ),
                        field("__proto__", o.optional({ type: o.string({}) })),
                    ],
                },
            ],
            actionTypes: [
                {
                    name: "updateEntry",
                    displayName: "Update Entry",
                    logic: [],
                    parameters: [
                        field("at", o.optional({ type: o.timestamp({}) })),
                        { ...field("id", o.string({})), defaultValue: o.Expression.uuid({}) },
                    ],
                },
            ],
            queryFunctionTypes: [
                {
                    name: "search",
                    displayName: "Search",
                    parameters: [field("at", o.optional({ type: o.timestamp({}) }))],
                    returnType: o.list({ elementType: o.ref({ name: "Entry" }) }),
                },
            ],
        };
        await checkGenerated(
            ir,
            `
            import assert from "node:assert/strict";
            import { Result, Schema } from "effect";
            import { Temporal } from "temporal-polyfill";
            import { readFileSync } from "node:fs";
            import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
            import * as s from "./effect.js";
            import type { Entry } from "./effect.js";
            const value: Entry = {
                id: 42, parent: 99, status: "open", name: "hello",
                createdAt: Temporal.Instant.from("2026-10-19T12:00:00.123456789Z"),
                dates: { birthday: Temporal.PlainDate.from("2000-02-29") },
                tree: { label: "root", children: [{ label: "leaf", children: [] }] },
                result: Result.succeed(Temporal.Instant.from("2026-10-19T00:00Z")),
                photo: { id: "image", type: "image/png", source: { objectType: "Entry", primaryKey: 42, property: "photo" } },
                position: { lat: 10, lon: 20 }, score: 1.25, rating: 9, active: true, metadata: { custom: true }, secret: { ciphertext: "encrypted-value" },
            };
            const parsed: Entry = Schema.decodeUnknownSync(Schema.toType(s.EntrySchema))(value);
            const runtime = compileEffectSchemas(JSON.parse(readFileSync(new URL("./ontology.json", import.meta.url), "utf8")));
            const runtimeEntry = runtime.objectSchemas.Entry!;
            assert.deepEqual(Schema.encodeSync(runtimeEntry)(value), Schema.encodeSync(s.EntrySchema)(value));
            assert.deepEqual(Schema.decodeUnknownSync(runtimeEntry)(Schema.encodeSync(s.EntrySchema)(value)), parsed);
            assert.equal(Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(runtimeEntry)))(value), Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(s.EntrySchema)))(value));
            assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
            assert.deepEqual(parsed.secret, { ciphertext: "encrypted-value" });
            assert.equal(parsed.parent, 99);
            const portable = Schema.encodeSync(s.EntrySchema)(value);
            assert.equal(portable.result.kind, "ok");
            assert(Result.isSuccess(Schema.decodeUnknownSync(s.EntrySchema)(portable).result));
            const failed = { ...value, result: Result.fail("bad") };
            assert.deepEqual(Schema.encodeSync(s.EntrySchema)(failed).result, { kind: "err", value: "bad" });
            assert(Result.isFailure(Schema.decodeUnknownSync(s.EntrySchema)(Schema.encodeSync(s.EntrySchema)(failed)).result));
            const json = Schema.toCodecJson(s.EntrySchema);
            const text = Schema.encodeSync(Schema.fromJsonString(json))(value);
            assert.equal(JSON.parse(text).createdAt, "2026-10-19T12:00:00.123456789Z");
            assert.equal(JSON.parse(text).dates.birthday, "2000-02-29");
            assert.equal(JSON.parse(text).result.value, "2026-10-19T00:00:00Z");
            const decoded: Entry = Schema.decodeUnknownSync(Schema.fromJsonString(json))(text);
            assert(decoded.createdAt instanceof Temporal.Instant);
            assert(decoded.dates.birthday instanceof Temporal.PlainDate);
            assert.equal(decoded.createdAt.epochNanoseconds, value.createdAt.epochNanoseconds);
            assert.deepEqual(decoded.tree, value.tree);
            for (const change of [
                { id: 2147483648 }, { id: 1.5 }, { id: 1n }, { parent: "wrong" },
                { status: "wrong" }, { name: "!" }, { photo: { id: "bad", type: "image/jpeg" } },
                { score: Infinity }, { active: "yes" }, { position: { lat: "wrong", lon: 1 } },
                { tree: { label: "root", children: [{ label: 7, children: [] }] } },
                { result: { kind: "other", value: "bad" } }, { createdAt: value.createdAt.toString() },
            ]) for (const schema of [s.EntrySchema, runtimeEntry]) assert.throws(() => Schema.decodeUnknownSync(Schema.toType(schema))({ ...value, ...change }));
            for (const bad of ["2026-02-30", "garbage"]) {
                assert.throws(() => Schema.decodeUnknownSync(json)({ ...JSON.parse(text), dates: { birthday: bad } }));
            }
            assert.throws(() => Schema.decodeUnknownSync(json)({ ...JSON.parse(text), createdAt: "2026-01-01T00:00" }));
            assert.deepEqual(Schema.decodeUnknownSync(s.UpdateEntryParametersSchema)({ at: null }), { at: null });
            assert.deepEqual(Schema.decodeUnknownSync(s.UpdateEntryParametersSchema)({}), {});
            assert.throws(() => Schema.decodeUnknownSync(s.UpdateEntryParametersSchema)({ id: null }));
            assert.deepEqual(Schema.decodeUnknownSync(s.SearchParametersSchema)({}), {});
            assert.throws(() => Schema.decodeUnknownSync(s.SearchParametersSchema)({ at: null }));
            assert.deepEqual(Schema.decodeUnknownSync(Schema.toType(s.SearchReturnSchema))([value]), [parsed]);
            assert.equal(s.objectSchemas.Entry, s.EntrySchema);
            assert.equal(s.actionParameterSchemas.updateEntry, s.UpdateEntryParametersSchema);
            assert.equal(s.queryParameterSchemas.search, s.SearchParametersSchema);
            assert.equal(s.queryReturnSchemas.search, s.SearchReturnSchema);
            assert.equal(s.namedSchemas.Node, s.NodeSchema);
            const nestedCodec = Schema.fromJsonString(Schema.toCodecJson(s.NestedOutcomeSchema));
            for (const nested of [Result.succeed(Result.succeed(Temporal.PlainDate.from("2000-02-29"))), Result.succeed(Result.fail(-1)), Result.fail(value.createdAt)]) {
                const decoded = Schema.decodeUnknownSync(nestedCodec)(Schema.encodeSync(nestedCodec)(nested));
                assert.deepEqual(decoded, nested);
            }
            assert.throws(() => Schema.decodeUnknownSync(Schema.toType(s.EntrySchema))({ ...value, ["__proto__"]: 4 }));
        `
        );
    }, 30000);

    it("handles the complete self-describing ontology and its mutually recursive types", async () => {
        const schemaPath = fileURLToPath(new URL("../../lib/ir/schema.js", import.meta.url));
        await checkGenerated(
            selfSchema,
            `
            import assert from "node:assert/strict";
            import { Schema } from "effect";
            import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
            import ir from ${JSON.stringify(schemaPath)};
            import { OntologyIRSchema } from "./effect.js";
            assert.deepEqual(Schema.decodeUnknownSync(OntologyIRSchema)(ir), ir);
            const codec = Schema.fromJsonString(Schema.toCodecJson(OntologyIRSchema));
            assert.deepEqual(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(ir)), ir);
            const runtime = compileEffectSchemas(ir).namedSchemas.OntologyIR!;
            assert.deepEqual(Schema.decodeUnknownSync(runtime)(ir), ir);
            const runtimeJson = Schema.fromJsonString(Schema.toCodecJson(runtime));
            assert.deepEqual(Schema.decodeUnknownSync(runtimeJson)(Schema.encodeSync(runtimeJson)(ir)), ir);
        `
        );
    }, 30000);

    it("rejects unresolved references, invalid names, bad regexes, and generated name collisions", () => {
        expect(() =>
            generateEffectSchemas({ ...empty, types: [{ name: "Missing", type: o.ref({ name: "Nope" }) }] })
        ).toThrow("Unknown ontology type");
        expect(() =>
            generateEffectSchemas({ ...empty, types: [{ name: "Bad;code", type: o.string({}) }] })
        ).toThrow("invalid TypeScript type name");
        expect(() =>
            generateEffectSchemas({
                ...empty,
                types: [
                    { name: "Bad", type: o.string({ constraint: o.StringConstraint.regex({ regex: "[" }) }) },
                ],
            })
        ).toThrow(/regular expression/i);
        expect(() =>
            generateEffectSchemas({
                ...empty,
                types: [{ name: "Missing", type: o.objectReference({ objectType: "Nope" }) }],
            })
        ).toThrow("Cannot resolve primary key");
        expect(() =>
            generateEffectSchemas({
                ...empty,
                types: [
                    { name: "Duplicate", type: o.string({}) },
                    { name: "Duplicate", type: o.integer({}) },
                ],
            })
        ).toThrow("Duplicate generated Effect schema");
    });
});
