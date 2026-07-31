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
    it("places every object type on the graph canvas", () => {
        const ir: OntologyIR = {
            types: [],
            objectTypes: ["Task", "User", "Project", "Comment"].map((name) => ({
                name,
                displayName: name,
                pluralDisplayName: `${name}s`,
                primaryKey: "id",
                properties: [],
            })),
            linkTypes: [],
            actionTypes: [],
            queryFunctionTypes: [],
        };

        const layout = layoutSchema(ir);

        expect(layout.nodes.map((node) => node.objectType.name)).toEqual([
            "Task",
            "User",
            "Project",
            "Comment",
        ]);
        expect(new Set(layout.nodes.map((node) => `${node.x}:${node.y}`)).size).toBe(4);
        expect(layout.width).toBeGreaterThan(0);
        expect(layout.height).toBeGreaterThan(0);
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
