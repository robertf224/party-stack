import {
    Graph,
    layout as layoutGraph,
    type EdgeLabel,
    type GraphLabel,
    type NodeLabel,
    type Point,
} from "@dagrejs/dagre";
import type { ObjectTypeDef, OntologyIR } from "@party-stack/ontology";

interface SchemaNode {
    objectType: ObjectTypeDef;
    x: number;
    y: number;
}

interface SchemaEdge {
    id: string;
    label: string;
    labelWidth: number;
    labelX: number;
    labelY: number;
    points: Point[];
}

interface SchemaGraphEdgeLabel extends EdgeLabel {
    label: string;
}

const SCHEMA_CARD_WIDTH = 230;
const SCHEMA_CARD_HEIGHT = 176;

export function schemaLinkLabel(
    ir: OntologyIR,
    side: OntologyIR["linkTypes"][number]["source"],
    cardinality: "one" | "many"
): string {
    const object = ir.objectTypes.find((type) => type.name === side.objectType);
    // Preserve relationship-specific labels; use the type's plural only for a default singular label.
    const label =
        cardinality === "many" && object?.displayName === side.displayName
            ? object.pluralDisplayName
            : side.displayName;
    return `${cardinality} ${label}`;
}

/** Diagram arrows run from the referenced object to dependents, so many means one-to-many. */
export function schemaRelationship(link: OntologyIR["linkTypes"][number]) {
    const label = link.cardinality === "many" ? "one-to-many" : "one-to-one";
    return {
        id: link.id,
        source: link.target.objectType,
        target: link.source.objectType,
        cardinality: link.cardinality,
        label,
        width: Math.min(180, Math.max(72, label.length * 6 + 16)),
    };
}

export function layoutSchema(ir: OntologyIR): {
    nodes: SchemaNode[];
    edges: SchemaEdge[];
    width: number;
    height: number;
} {
    const graph = new Graph<GraphLabel, NodeLabel, SchemaGraphEdgeLabel>({ multigraph: true })
        .setGraph({
            marginx: 24,
            marginy: 24,
            nodesep: 32,
            rankdir: "LR",
            ranksep: 100,
        })
        .setDefaultEdgeLabel(() => ({ label: "" }));

    for (const objectType of ir.objectTypes) {
        graph.setNode(objectType.name, {
            height: SCHEMA_CARD_HEIGHT,
            width: SCHEMA_CARD_WIDTH,
        });
    }
    for (const link of ir.linkTypes) {
        const edgeLabel = schemaRelationship(link);
        graph.setEdge(
            edgeLabel.source,
            edgeLabel.target,
            {
                height: 24,
                label: edgeLabel.label,
                width: edgeLabel.width,
            },
            link.id
        );
    }

    layoutGraph(graph);

    const objectTypeByName = new Map(ir.objectTypes.map((objectType) => [objectType.name, objectType]));
    const nodes = graph
        .nodes()
        .map((name) => {
            const objectType = objectTypeByName.get(name);
            const node = graph.node(name);
            if (!objectType || !node) return undefined;
            return {
                objectType,
                x: (node.x ?? 0) - SCHEMA_CARD_WIDTH / 2,
                y: (node.y ?? 0) - SCHEMA_CARD_HEIGHT / 2,
            };
        })
        .filter((node): node is SchemaNode => node !== undefined);
    const edges = graph.edges().map((edge) => {
        const value = graph.edge(edge);
        return {
            id: edge.name ?? `${edge.v}-${edge.w}`,
            label: value.label ?? "",
            labelWidth: value.width ?? 72,
            labelX: value.x ?? value.points?.[0]?.x ?? 0,
            labelY: value.y ?? value.points?.[0]?.y ?? 0,
            points: value.points ?? [],
        };
    });
    const graphSize = graph.graph();

    return {
        nodes,
        edges,
        width: Math.max(310, graphSize.width ?? 0),
        height: Math.max(256, graphSize.height ?? 0),
    };
}
