import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendError } from "@party-stack/ontology-backend";
import { makeMetadataBackend } from "@party-stack/ontology-backend/meta";
import { MemoryRuntime, Runtimes } from "@party-stack/runtime";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { writePulledOntology } from "./pull.js";
import type { OntologyIR, OntologyPullConfig } from "../index.js";

const directories: string[] = [];
const empty: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
};
afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const destination = async () => {
    const dir = await mkdtemp(join(tmpdir(), "native-pull-"));
    directories.push(dir);
    return join(dir, "ontology.ts");
};
const configuration = (cleanup: () => void): OntologyPullConfig => ({
    backend: Effect.acquireRelease(Effect.succeed(makeMetadataBackend(empty)), () => Effect.sync(cleanup)),
    objectTypeNames: [],
    actionTypeNames: [],
});

describe("native metadata CLI", () => {
    it("pulls and formats through the metadata backend without opening an installation or evaluating Vite config", async () => {
        const path = await destination();
        await writeFile(
            join(path, "..", "vite.config.ts"),
            'throw new Error("must not evaluate vite config")'
        );
        const closed = vi.fn();
        const config = configuration(closed);
        await writePulledOntology(config, path, { runtime: Runtimes.layer(MemoryRuntime.layer) });
        expect(await readFile(path, "utf8")).toContain("export default");
        expect(closed).toHaveBeenCalledOnce();
    });
    it("closes backend acquisition when a transform fails", async () => {
        const path = await destination(),
            closed = vi.fn();
        const config = configuration(closed);
        const updated = {
            ...config,
            transformPulledOntology: () => {
                throw new Error("transform failed");
            },
        };
        await expect(
            writePulledOntology(updated, path, { runtime: Runtimes.layer(MemoryRuntime.layer) })
        ).rejects.toThrow("transform failed");
        expect(closed).toHaveBeenCalledOnce();
    });
    it("releases backend resources when metadata loading fails", async () => {
        const path = await destination(),
            closed = vi.fn();
        const config = configuration(closed);
        const updated = {
            ...config,
            backend: config.backend.pipe(
                Effect.map((backend) => ({
                    ...backend,
                    query: () =>
                        Effect.fail(
                            new BackendError({
                                operation: "metadata",
                                kind: "Unavailable",
                                retryable: false,
                                message: "load failed",
                            })
                        ),
                }))
            ),
        };
        await expect(
            writePulledOntology(updated, path, { runtime: Runtimes.layer(MemoryRuntime.layer) })
        ).rejects.toThrow("load failed");
        expect(closed).toHaveBeenCalledOnce();
    });
});
