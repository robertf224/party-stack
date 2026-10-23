import { o } from "@party-stack/ontology-spec";
import { Effect, Exit } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { convertFoundryMetaObjectType } from "../meta/convertMetaObjectType.js";
import { convertFoundryObjectPropertyType } from "../meta/convertMetaTypeDef.js";
import { createFoundryOntologyBackendAdapter } from "./createFoundryOntologyBackendAdapter.js";
import { makeFoundryEncryptedValues } from "./encrypted.js";
import { createFoundryCodec } from "./foundryCodec.js";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { OntologyIR } from "@party-stack/ontology-spec";

const calls = vi.hoisted(() => ({ decrypt: vi.fn() }));
vi.mock("@osdk/foundry.ontologies", async (original) => ({
    ...(await original<typeof import("@osdk/foundry.ontologies")>()),
    CipherTextProperties: calls,
}));

const cipher = "CIPHER::ri.bellaso.main.cipher-channel.test::encrypted-data::CIPHER";
const source = { objectType: "Person", primaryKey: "person-1", property: "ssn" };
const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Person",
            displayName: "Person",
            pluralDisplayName: "People",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                {
                    name: "ssn",
                    displayName: "SSN",
                    type: o.optional({ type: o.encrypted({ type: o.string({}) }) }),
                },
            ],
        },
    ],
};
const client = { ontologyRid: "ontology", fetch: vi.fn() } as unknown as OntologyClient;
const backend = makeFoundryEncryptedValues(client, ir);
beforeEach(() => vi.resetAllMocks());

describe("Foundry encrypted properties", () => {
    it("imports CipherText as an encrypted string and preserves opaque handles on snapshot/edit loads", () => {
        expect(convertFoundryObjectPropertyType({ type: "cipherText" })).toEqual(
            o.encrypted({ type: o.string({}) })
        );
        const codec = createFoundryCodec(ir);
        for (const decode of [codec.decodeObject, codec.decodeEditObject]) {
            expect(decode("Person", { id: "person-1", ssn: cipher })).toEqual({
                id: "person-1",
                ssn: { id: cipher, source },
            });
            expect(decode("Person", { id: "person-1", ssn: null })).toEqual({
                id: "person-1",
                ssn: undefined,
            });
        }
        expect(codec.encodeValue(o.encrypted({ type: o.string({}) }), { id: cipher })).toBe(cipher);
        expect(() => codec.encodeValue(o.encrypted({ type: o.string({}) }), "plaintext")).toThrow(
            "Expected object"
        );
        expect(calls.decrypt).not.toHaveBeenCalled();
    });

    it("decrypts explicitly through the property API every time, without caching", async () => {
        calls.decrypt.mockResolvedValue({ plaintext: "123-45-6789" });
        for (let i = 0; i < 2; i++)
            expect(await Effect.runPromise(backend.decrypt({ id: cipher, source }))).toEqual({
                value: "123-45-6789",
            });
        expect(calls.decrypt).toHaveBeenCalledTimes(2);
        expect(calls.decrypt).toHaveBeenCalledWith(
            expect.objectContaining({ fetch: expect.any(Function) }),
            "ontology",
            "Person",
            "person-1",
            "ssn"
        );
    });

    it("wires decryption into the native backend binding", async () => {
        calls.decrypt.mockResolvedValue({ plaintext: "value" });
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const native = yield* createFoundryOntologyBackendAdapter({
                        client,
                        ir,
                        live: false,
                    }).open({});
                    expect(native.encrypted).toBeDefined();
                    expect(yield* native.encrypted!.decrypt({ id: cipher, source })).toEqual({
                        value: "value",
                    });
                })
            )
        );
    });

    it("keeps value-type metadata inside the encrypted wrapper", () => {
        const converted = convertFoundryMetaObjectType({
            objectType: {
                apiName: "Person",
                displayName: "Person",
                pluralDisplayName: "People",
                primaryKey: "id",
                rid: "ri.ontology.main.object-type.person",
                status: "ACTIVE",
                properties: {
                    ssn: {
                        dataType: { type: "cipherText" },
                        valueTypeApiName: "Ssn",
                        rid: "ri.ontology.main.property.ssn",
                    },
                },
            },
            linkTypes: [],
            implementsInterfaces: [],
            implementsInterfaces2: {},
            sharedPropertyTypeMapping: {},
        } as unknown as Parameters<typeof convertFoundryMetaObjectType>[0]);
        expect(converted.properties[0]?.type).toEqual(
            o.optional({ type: o.encrypted({ type: o.ref({ name: "Ssn" }) }) })
        );
    });

    it("propagates interruption to provider HTTP requests", async () => {
        let requestSignal: AbortSignal | undefined;
        const fetch = vi.fn(
            (_input: unknown, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    requestSignal = init?.signal ?? undefined;
                    requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
                        once: true,
                    });
                })
        );
        const values = makeFoundryEncryptedValues({ ...client, fetch } as OntologyClient, ir);
        calls.decrypt.mockImplementation((scopedClient: OntologyClient) =>
            scopedClient.fetch("https://foundry.example/decrypt")
        );
        const controller = new AbortController();
        const result = Effect.runPromiseExit(values.decrypt({ id: cipher, source }), {
            signal: controller.signal,
        });
        await vi.waitFor(() => expect(requestSignal).toBeDefined());
        controller.abort();
        expect(Exit.isFailure(await result)).toBe(true);
        expect(requestSignal?.aborted).toBe(true);
    });

    it("rejects missing/unknown/non-encrypted property targets before making a request", async () => {
        for (const handle of [
            { id: cipher },
            { id: cipher, source: { ...source, objectType: "Unknown" } },
            { id: cipher, source: { ...source, property: "id" } },
        ])
            expect(Exit.isFailure(await Effect.runPromiseExit(backend.decrypt(handle)))).toBe(true);
        expect(calls.decrypt).not.toHaveBeenCalled();
    });

    it("validates the property plaintext schema and redacts invalid plaintext from errors", async () => {
        calls.decrypt.mockResolvedValue({ plaintext: "sensitive invalid plaintext" });
        const strict = structuredClone(ir);
        strict.objectTypes[0]!.properties.find((property) => property.name === "ssn")!.type = o.encrypted({
            type: o.string({ constraint: o.StringConstraint.regex({ regex: "^[0-9-]+$" }) }),
        });
        const exit = await Effect.runPromiseExit(
            makeFoundryEncryptedValues(client, strict).decrypt({ id: cipher, source })
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).not.toContain("sensitive invalid plaintext");
    });

    it("rejects unsupported plaintext types before calling Foundry", async () => {
        const numeric = structuredClone(ir);
        numeric.objectTypes[0]!.properties.find((property) => property.name === "ssn")!.type = o.encrypted({
            type: o.integer({}),
        });
        expect(
            Exit.isFailure(
                await Effect.runPromiseExit(
                    makeFoundryEncryptedValues(client, numeric).decrypt({ id: cipher, source })
                )
            )
        ).toBe(true);
        expect(calls.decrypt).not.toHaveBeenCalled();
    });

    it.each([
        [403, "Rejected", false],
        [404, "NotFound", false],
        [429, "Unavailable", true],
        [503, "Unavailable", true],
    ])(
        "classifies status %s without retaining sensitive provider errors",
        async (statusCode, kind, retryable) => {
            calls.decrypt.mockRejectedValue({ statusCode, body: "sensitive provider body" });
            const error = await Effect.runPromise(backend.decrypt({ id: cipher, source }).pipe(Effect.flip));
            expect(error).toMatchObject({ _tag: "BackendError", kind, retryable });
            expect(JSON.stringify(error)).not.toContain("sensitive provider body");
        }
    );
});
