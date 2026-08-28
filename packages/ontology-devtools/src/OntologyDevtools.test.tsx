import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { LiveOntology, OntologyIR, OntologyOutboxEntry } from "@party-stack/ontology";
import {
    createOntologyDevtoolsPlugin,
    getOutboxActivity,
    layoutSchema,
    moveColumn,
    OntologyDevtoolsPanel,
    OntologyDevtoolsPluginName,
    ontologyDevtoolsTrigger,
    OntologyDevtoolsTrigger,
    schemaEdgePath,
    timestampPreview,
    typeDisplayName,
    type OntologyDevtoolsPanelProps,
} from "./OntologyDevtools.js";

describe("createOntologyDevtoolsPlugin", () => {
    it("creates a composable TanStack Devtools plugin", () => {
        const ontology = {} as LiveOntology;
        const plugin = createOntologyDevtoolsPlugin({ ontology });

        expect(plugin.id).toBe("party-stack-ontology");
        expect(plugin.name).toBeTypeOf("function");
        expect(plugin.defaultOpen).toBeUndefined();
        expect(plugin.render).toBeTypeOf("function");

        if (typeof plugin.render !== "function") {
            throw new Error("Expected the plugin render property to be a function");
        }

        const panel = plugin.render({} as HTMLElement, {
            devtoolsOpen: true,
            theme: "light",
        }) as ReactElement<OntologyDevtoolsPanelProps>;

        expect(isValidElement(panel)).toBe(true);
        expect(panel.props).toMatchObject({ devtoolsOpen: true, theme: "light" });

        const Component = panel.type as (props: typeof panel.props) => ReactElement;
        const ontologyPanel = Component(panel.props) as ReactElement<OntologyDevtoolsPanelProps>;
        expect(ontologyPanel.type).toBe(OntologyDevtoolsPanel);
        expect(ontologyPanel.props).toMatchObject({ ontology, theme: "light" });

        if (typeof plugin.name !== "function") {
            throw new Error("Expected the plugin name property to be a function");
        }
        const title = plugin.name({} as HTMLElement, {
            devtoolsOpen: true,
            theme: "light",
        });
        expect(title.type).toBe(OntologyDevtoolsPluginName);
        expect(title.props).toMatchObject({ theme: "light" });
    });

    it("forwards plugin metadata", () => {
        const plugin = createOntologyDevtoolsPlugin({
            ontology: {} as LiveOntology,
            id: "custom-ontology",
            name: "Data model",
            defaultOpen: true,
        });

        expect(plugin).toMatchObject({
            id: "custom-ontology",
            name: "Data model",
            defaultOpen: true,
        });
    });

    it("exports the branded shell trigger separately", () => {
        const trigger = ontologyDevtoolsTrigger({} as HTMLElement, { theme: "dark" });

        expect(trigger.type).toBe(OntologyDevtoolsTrigger);
        expect(trigger.props).toMatchObject({ theme: "dark" });
    });
});

describe("layoutSchema", () => {
    it("places every object type on a relationship-aware graph canvas", () => {
        const ir: OntologyIR = {
            types: [],
            objectTypes: ["Task", "User", "Project", "Comment"].map((name) => ({
                name,
                displayName: name,
                pluralDisplayName: `${name}s`,
                primaryKey: "id",
                properties: [],
            })),
            linkTypes: [
                {
                    id: "project-tasks",
                    source: {
                        objectType: "Project",
                        name: "tasks",
                        displayName: "Tasks",
                    },
                    target: {
                        objectType: "Task",
                        name: "project",
                        displayName: "Project",
                    },
                    foreignKey: "projectId",
                    cardinality: "many",
                },
            ],
            actionTypes: [],
            queryFunctionTypes: [],
        };

        const layout = layoutSchema(ir);
        const project = layout.nodes.find((node) => node.objectType.name === "Project");
        const task = layout.nodes.find((node) => node.objectType.name === "Task");

        expect(layout.nodes.map((node) => node.objectType.name)).toEqual([
            "Task",
            "User",
            "Project",
            "Comment",
        ]);
        expect(new Set(layout.nodes.map((node) => `${node.x}:${node.y}`)).size).toBe(4);
        expect(layout.width).toBeGreaterThan(0);
        expect(layout.height).toBeGreaterThan(0);
        expect(project?.x).toBeLessThan(task?.x ?? 0);
        expect(layout.edges).toHaveLength(1);
        expect(layout.edges[0]!.label).toBe("Tasks · many");
    });

    it("routes relationship arrows to the object card boundaries", () => {
        const objectTypes = ["Project", "Task"].map((name) => ({
            name,
            displayName: name,
            pluralDisplayName: `${name}s`,
            primaryKey: "id",
            properties: [],
        }));
        const ir: OntologyIR = {
            types: [],
            objectTypes,
            linkTypes: [
                {
                    id: "project-tasks",
                    source: { objectType: "Project", name: "tasks", displayName: "Tasks" },
                    target: { objectType: "Task", name: "project", displayName: "Project" },
                    foreignKey: "projectId",
                    cardinality: "many",
                },
            ],
            actionTypes: [],
            queryFunctionTypes: [],
        };

        const layout = layoutSchema(ir);
        const source = layout.nodes.find((node) => node.objectType.name === "Project");
        const target = layout.nodes.find((node) => node.objectType.name === "Task");
        const points = layout.edges[0]!.points;
        const touchesBoundary = (
            point: { x: number; y: number },
            node: NonNullable<typeof source>
        ) => {
            const onHorizontalEdge =
                (point.y === node.y || point.y === node.y + 176) &&
                point.x >= node.x &&
                point.x <= node.x + 230;
            const onVerticalEdge =
                (point.x === node.x || point.x === node.x + 230) &&
                point.y >= node.y &&
                point.y <= node.y + 176;
            return onHorizontalEdge || onVerticalEdge;
        };

        expect(source).toBeDefined();
        expect(target).toBeDefined();
        expect(touchesBoundary(points[0]!, source!)).toBe(true);
        expect(touchesBoundary(points.at(-1)!, target!)).toBe(true);
        expect(points.at(-1)).not.toEqual({
            x: target!.x + 115,
            y: target!.y + 88,
        });
    });

    it("turns routed points into a rounded SVG path", () => {
        expect(
            schemaEdgePath([
                { x: 0, y: 0 },
                { x: 20, y: 0 },
                { x: 20, y: 20 },
            ])
        ).toBe("M 0 0 L 10 0 Q 20 0 20 10 L 20 20");
    });
});

describe("property presentation", () => {
    const ir: OntologyIR = {
        types: [
            {
                name: "EventTime",
                type: { kind: "timestamp", value: {} },
            },
        ],
        objectTypes: [],
        linkTypes: [],
        actionTypes: [],
        queryFunctionTypes: [],
    };

    it("describes named and container property types", () => {
        expect(
            typeDisplayName(ir, {
                kind: "optional",
                value: {
                    type: {
                        kind: "list",
                        value: {
                            elementType: { kind: "attachment", value: {} },
                        },
                    },
                },
            })
        ).toBe("List of Attachment (optional)");
        expect(typeDisplayName(ir, { kind: "ref", value: { name: "EventTime" } })).toBe(
            "EventTime"
        );
    });

    it("formats timestamps for display while retaining the exact value", () => {
        const preview = timestampPreview(new Date("2026-07-31T08:00:00.000Z"));

        expect(preview?.display).not.toBe("2026-07-31T08:00:00.000Z");
        expect(preview?.exact).toBe('"2026-07-31T08:00:00.000Z"');
    });
});

describe("getOutboxActivity", () => {
    function entry(
        overrides: Partial<OntologyOutboxEntry> = {}
    ): OntologyOutboxEntry {
        return {
            id: "entry",
            sequence: 1,
            request: {
                actionTypeName: "save",
                idempotencyKey: "key",
                parameters: {},
            },
            status: "queued",
            createdAt: 0,
            updatedAt: 0,
            attempts: 0,
            retryable: true,
            nextAttemptAt: 0,
            ...overrides,
        };
    }

    it("derives idle, draining, and blocked states", () => {
        expect(getOutboxActivity([])).toBe("idle");
        expect(getOutboxActivity([entry()])).toBe("draining");
        expect(
            getOutboxActivity([entry({ nextAttemptAt: Date.now() + 60_000 })])
        ).toBe("draining");
        expect(getOutboxActivity([entry({ status: "executing" })])).toBe("draining");
        expect(
            getOutboxActivity([
                entry({ id: "blocked", sequence: 1, status: "failed" }),
                entry({ id: "behind", sequence: 2 }),
            ])
        ).toBe("paused");
    });
});

describe("moveColumn", () => {
    it("moves one column before the drop target", () => {
        expect(moveColumn(["first", "second", "third", "fourth"], "fourth", "second")).toEqual([
            "first",
            "fourth",
            "second",
            "third",
        ]);
    });
});
