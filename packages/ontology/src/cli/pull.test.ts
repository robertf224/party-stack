import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRuntime } from "@party-stack/runtime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { writePulledOntology } from "./pull.js";
import type { OntologyIR, OntologyPullConfig } from "../index.js";
import type { RuntimeLayer } from "@party-stack/runtime";

const mocks = vi.hoisted(() => ({
    pull: vi.fn(),
    generateOntology: vi.fn(() => "export default {};"),
}));

vi.mock("../meta/pull.js", () => ({
    pull: mocks.pull,
}));
vi.mock("@party-stack/ontology-spec/generate", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@party-stack/ontology-spec/generate")>()),
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
        const runtime = vi.fn() as unknown as RuntimeLayer;
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
        mocks.generateOntology.mockReturnValueOnce("export default {\nname: 'pulled',\n};");
        await writeFile(
            join(directory, "vite.config.ts"),
            'throw new Error("Vite config must not be evaluated");'
        );

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
        expect(await readFile(join(directory, "ontology.ts"), "utf8")).toBe(
            '// Auto-generated file - do not edit manually\n\nexport default {\n    name: "pulled",\n};\n'
        );
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
                runtime: MemoryRuntime.layer,
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
                runtime: MemoryRuntime.layer,
            })
        ).rejects.toThrow("open failed");
        expect(cleanup).toHaveBeenCalledOnce();
    });
});
