import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RuntimeTestDurableObject } from "./worker.js";

interface TestEnvironment {
    RUNTIME: DurableObjectNamespace<RuntimeTestDurableObject>;
}

const testEnvironment = env as unknown as TestEnvironment;

function createStub() {
    return testEnvironment.RUNTIME.get(testEnvironment.RUNTIME.newUniqueId());
}

describe("Cloudflare Durable Object runtime", () => {
    it("persists and reconstructs namespace-isolated collections after eviction", async () => {
        const stub = createStub();
        await stub.putRuntimeRecord("alice", "host", "same", "alice-host");
        await stub.putRuntimeRecord("alice", "system", "same", "alice-system");
        await stub.putRuntimeRecord("a", "b:c", "same", "first-colliding-scope");
        await stub.putRuntimeRecord("a:b", "c", "same", "second-colliding-scope");
        await stub.putRuntimeRecord("values", "special", "special", {
            date: new Date("2026-08-28T00:00:00Z"),
            nan: Number.NaN,
            infinity: Number.POSITIVE_INFINITY,
            negativeInfinity: Number.NEGATIVE_INFINITY,
            bigint: 42n,
            sparse: Object.assign(new Array<unknown>(2), { 1: "value" }),
            __party_stack_cloudflare_runtime_type__: "application-value",
        });
        await stub.putTemporalRecord();

        await evictDurableObject(stub);

        await expect(stub.getRuntimeRecord("alice", "host", "same")).resolves.toBe("alice-host");
        await expect(stub.getRuntimeRecord("alice", "system", "same")).resolves.toBe("alice-system");
        await expect(stub.getRuntimeRecord("a", "b:c", "same")).resolves.toBe("first-colliding-scope");
        await expect(stub.getRuntimeRecord("a:b", "c", "same")).resolves.toBe("second-colliding-scope");
        await expect(stub.getRuntimeRecord("values", "special", "special")).resolves.toEqual({
            date: new Date("2026-08-28T00:00:00Z"),
            nan: Number.NaN,
            infinity: Number.POSITIVE_INFINITY,
            negativeInfinity: Number.NEGATIVE_INFINITY,
            bigint: 42n,
            sparse: Object.assign(new Array<unknown>(2), { 1: "value" }),
            __party_stack_cloudflare_runtime_type__: "application-value",
        });
        await expect(stub.temporalRecordSummary()).resolves.toEqual({
            instant: "2026-08-28T00:00:00Z",
            instantTag: "Temporal.Instant",
            date: "2026-08-28",
            dateTag: "Temporal.PlainDate",
        });
    });

    it("distinguishes cleanup, namespace destroy, and installation destroy", async () => {
        const stub = createStub();
        await expect(stub.destroyWithActivePeerIsBlocked()).resolves.toBe(true);
        await stub.putRuntimeRecord("alice", "host", "one", "retained");
        await stub.putRuntimeRecord("alice", "system", "one", "isolated");
        await stub.setSecret("alice", "host", "token", "host-secret");
        await stub.setSecret("alice", "system", "token", "system-secret");
        await stub.cleanupRuntime("alice", "host");
        await expect(stub.getRuntimeRecord("alice", "host", "one")).resolves.toBe("retained");

        await stub.destroyRuntime("alice", "host");
        await expect(stub.getRuntimeRecord("alice", "host", "one")).resolves.toBeUndefined();
        await expect(stub.getRuntimeRecord("alice", "system", "one")).resolves.toBe("isolated");
        await expect(stub.getSecret("alice", "host", "token")).resolves.toBeUndefined();
        await expect(stub.getSecret("alice", "system", "token")).resolves.toBe("system-secret");

        await stub.destroyInstallation();
        await runInDurableObject(stub, (_instance, state) => {
            expect(
                state.storage.sql
                    .exec(
                        `SELECT name
                             FROM sqlite_master
                             WHERE name LIKE 'party_stack_%'`
                    )
                    .toArray()
            ).toEqual([]);
        });
    });

    it("stores namespaced Blob bytes in a real R2 binding", async () => {
        const stub = createStub();
        await stub.writeBlob("alice", "host", "same", "host bytes", "text/plain");
        await stub.writeBlob("alice", "host", "same", "host bytes", "text/plain");
        await stub.writeBlob("alice", "system", "same", "system bytes", "text/custom");
        await expect(stub.readBlob("alice", "host", "same")).resolves.toEqual({
            content: "host bytes",
            type: "text/plain",
        });
        await expect(stub.readBlob("alice", "system", "same")).resolves.toEqual({
            content: "system bytes",
            type: "text/custom",
        });
        await stub.destroyRuntime("alice", "host");
        await expect(stub.hasBlob("alice", "host", "same")).resolves.toBe(false);
        await expect(stub.readBlob("alice", "system", "same")).resolves.toEqual({
            content: "system bytes",
            type: "text/custom",
        });
        await expect(stub.missingBlobError()).resolves.toMatchObject({
            name: "R2BlobNotFoundError",
            message: expect.stringContaining("R2 blob bytes not found"),
        });
    });

    it("uses R2 as authoritative SQLite attachment storage", async () => {
        await expect(createStub().runAuthoritativeR2Attachments()).resolves.toEqual({
            content: "r2-authoritative",
            type: "text/plain",
            sqlBytesAreExternal: true,
            orphanCollected: true,
        });
    });

    it("wires DO SQLite, runtime persistence, and R2 through the high-level factory", async () => {
        await expect(createStub().runHighLevelFactory()).resolves.toEqual({
            content: "factory-r2",
            sqlBytesAreExternal: true,
        });
    });

    it("integrates the real Better Auth connection adapter with owned SQLite", async () => {
        const result = await createStub().runBetterAuthIntegration();
        expect(result).toEqual({
            usersSharedData: true,
            canonicalUsers: true,
            disconnectedState: "inactive",
            forgotten: true,
            reconstructedState: "inactive",
            authoritativeDataRetained: true,
        });
    });
});
