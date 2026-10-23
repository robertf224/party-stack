import { o } from "@party-stack/ontology";
import { describe, expect, it, vi } from "vite-plus/test";
import { runFoundryOntologyMutator } from "./stagedWrites.js";
import type { FoundryStagedWriteClient } from "./stagedWrites.js";
import type { OntologyIR } from "@party-stack/ontology";

const ir: OntologyIR = {
    types: [],
    objectTypes: [
        {
            name: "Task",
            displayName: "Task",
            pluralDisplayName: "Tasks",
            primaryKey: "id",
            properties: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
            ],
        },
    ],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
};

describe("runFoundryOntologyMutator", () => {
    it("writes through the ambient staged-write client", async () => {
        const calls: unknown[] = [];
        const client: FoundryStagedWriteClient = {
            create: (type, object) => {
                calls.push(["create", type, object]);
                return Promise.resolve();
            },
            update: (object, changes) => {
                calls.push(["update", object, changes]);
                return Promise.resolve();
            },
            delete: (object) => {
                calls.push(["delete", object]);
                return Promise.resolve();
            },
        };

        await runFoundryOntologyMutator({
            ir,
            client,
            mutator: async ({ tx }) => {
                await tx.mutate.Task!.create({
                    id: "task-1",
                });
                await tx.mutate.Task!.update("task-1", {
                    title: "Updated",
                });
            },
            args: {},
            objectTypes: {
                Task: "TaskToken",
            },
        });

        expect(calls).toEqual([
            ["create", "TaskToken", { id: "task-1" }],
            [
                "update",
                {
                    $apiName: "Task",
                    $primaryKey: "task-1",
                },
                { title: "Updated" },
            ],
        ]);
    });
});

it("encrypts plaintext and copies opaque Foundry handles through v2 staged edits", async () => {
    const schema = structuredClone(ir);
    schema.objectTypes[0]!.properties.push({
        name: "secret",
        displayName: "Secret",
        type: o.optional({ type: o.encrypted({ type: o.string({}) }) }),
    });
    const create = vi.fn(async () => {});
    const update = vi.fn(async () => {});
    const ciphertext = "CIPHER::channel::opaque::CIPHER";
    await runFoundryOntologyMutator({
        ir: schema,
        client: { create, update, delete: async () => {} },
        args: {},
        mutator: async ({ tx }) => {
            await tx.mutate.Task!.create({ id: "one", secret: "private test value" });
            await tx.mutate.Task!.update("one", { secret: { id: ciphertext } });
            await tx.mutate.Task!.update("one", [{ path: ["secret"], value: "rotated" }]);
            await tx.mutate.Task!.update("one", { secret: undefined });
        },
    });
    expect(create).toHaveBeenCalledWith(
        { $apiName: "Task" },
        { id: "one", secret: { plaintext: "private test value" } }
    );
    expect(update.mock.calls).toEqual([
        [{ $apiName: "Task", $primaryKey: "one" }, { secret: { ciphertext } }],
        [{ $apiName: "Task", $primaryKey: "one" }, { secret: { plaintext: "rotated" } }],
        [{ $apiName: "Task", $primaryKey: "one" }, { secret: undefined }],
    ]);
    await expect(
        runFoundryOntologyMutator({
            ir: schema,
            client: { create, update, delete: async () => {} },
            args: {},
            mutator: ({ tx }) => tx.mutate.Task!.update("one", { secret: { id: "device-only-handle" } }),
        })
    ).rejects.toThrow("Foundry encrypted handle");
});

it("preserves real OSDK ciphertext objects without invoking their decrypt method", async () => {
    const schema = structuredClone(ir);
    schema.objectTypes[0]!.properties.push({
        name: "secret",
        displayName: "Secret",
        type: o.encrypted({ type: o.string({}) }),
    });
    const decrypt = vi.fn(async () => "must-not-be-read");
    const sdkCiphertext = { decrypt };
    const update = vi.fn(async () => {});
    await runFoundryOntologyMutator({
        ir: schema,
        client: { create: async () => {}, update, delete: async () => {} },
        args: {},
        mutator: ({ tx }) => tx.mutate.Task!.update("one", { secret: sdkCiphertext }),
    });
    expect(update).toHaveBeenCalledWith({ $apiName: "Task", $primaryKey: "one" }, { secret: sdkCiphertext });
    expect(decrypt).not.toHaveBeenCalled();
});
