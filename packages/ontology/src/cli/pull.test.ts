import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAdapterProvider } from "@party-stack/runtime";
import { writePulledOntology } from "./pull.js";
import type { OntologyIR, OntologyPullConfig } from "../index.js";

const mocks = vi.hoisted(() => ({
    pull: vi.fn(),
    generateOntology: vi.fn(() => "export default {};"),
}));

vi.mock("../meta/pull.js", () => ({
    pull: mocks.pull,
}));
vi.mock("../generate/ontology.js", () => ({
    generateOntology: mocks.generateOntology,
}));

const directories: string[] = [];
const emptyOntology: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
};

afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(
        directories.splice(0).map((directory) =>
            rm(directory, {
                recursive: true,
                force: true,
            })
        )
    );
});

describe("writePulledOntology", () => {
    it("opens metadata through the source installation", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ontology-pull-"));
        directories.push(directory);
        const runtime = vi.fn() as unknown as RuntimeAdapterProvider;
        const liveOntology = { id: "meta" };
        const cleanup = vi.fn(() => Promise.resolve());
        const openMetaOntology = vi.fn(() => Promise.resolve(liveOntology));
        const installation = {
            openMetaOntology,
            cleanup,
        } as never;
        const createInstallation = vi.fn(() => Promise.resolve(installation));
        const resolveConnection = vi.fn(() =>
            Promise.resolve({
                userId: "user-1",
                state: { status: "active" as const },
            })
        );
        const config: OntologyPullConfig = {
            source: {
                ontologyId: "ri.ontology.main",
                createInstallation,
                resolveConnection,
            },
            objectTypeNames: [],
            actionTypeNames: [],
        };
        mocks.pull.mockResolvedValue(emptyOntology);

        await writePulledOntology(config, join(directory, "ontology.ts"), {
            runtime,
        });

        expect(createInstallation).toHaveBeenCalledWith({ runtime });
        expect(resolveConnection).toHaveBeenCalledWith(installation);
        expect(openMetaOntology).toHaveBeenCalledWith({
            userId: "user-1",
            ontologyId: "ri.ontology.main",
        });
        expect(mocks.pull).toHaveBeenCalledWith(liveOntology, expect.any(Object));
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it("cleans up the installation when transformation fails", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ontology-pull-"));
        directories.push(directory);
        const cleanup = vi.fn(() => Promise.resolve());
        const installation = {
            openMetaOntology: () => Promise.resolve({}),
            cleanup,
        } as never;
        const config: OntologyPullConfig = {
            source: {
                ontologyId: "ri.ontology.main",
                createInstallation: () => Promise.resolve(installation),
                resolveConnection: () =>
                    Promise.resolve({
                        userId: "user-1",
                        state: { status: "active" },
                    }),
                transformPulledOntology: () => {
                    throw new Error("transform failed");
                },
            },
            objectTypeNames: [],
            actionTypeNames: [],
        };
        mocks.pull.mockResolvedValue(emptyOntology);

        await expect(
            writePulledOntology(config, join(directory, "ontology.ts"), {
                runtime: vi.fn() as unknown as RuntimeAdapterProvider,
            })
        ).rejects.toThrow("transform failed");
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it("cleans up the installation when opening metadata fails", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ontology-pull-"));
        directories.push(directory);
        const cleanup = vi.fn(() => Promise.resolve());
        const installation = {
            openMetaOntology: () => Promise.reject(new Error("open failed")),
            cleanup,
        } as never;
        const config: OntologyPullConfig = {
            source: {
                ontologyId: "ri.ontology.main",
                createInstallation: () => Promise.resolve(installation),
                resolveConnection: () =>
                    Promise.resolve({
                        userId: "user-1",
                        state: { status: "active" },
                    }),
            },
            objectTypeNames: [],
            actionTypeNames: [],
        };

        await expect(
            writePulledOntology(config, join(directory, "ontology.ts"), {
                runtime: vi.fn() as unknown as RuntimeAdapterProvider,
            })
        ).rejects.toThrow("open failed");
        expect(cleanup).toHaveBeenCalledOnce();
    });
});
