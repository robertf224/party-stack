import {
    Background,
    Controls,
    Handle,
    MarkerType,
    Position,
    ReactFlow,
    useNodesInitialized,
    useNodesState,
    useReactFlow,
    useStore,
} from "@xyflow/react";
import { KeyRound, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ObjectTypeIcon } from "./OntologyIcons.js";
import { layoutSchema, schemaLinkLabel, schemaRelationship } from "./schemaLayout.js";
import { typeDisplayName } from "./typeDisplayName.js";
import type { OntologyIR, ObjectTypeDef } from "@party-stack/ontology";
import type { Node, NodeProps, Edge } from "@xyflow/react";

type ObjectNode = Node<{ object: ObjectTypeDef; outgoing: string[]; incoming: string[] }, "object">;
function ObjectCard({ data }: NodeProps<ObjectNode>) {
    const properties = [...data.object.properties].sort(
        (a, b) => Number(b.name === data.object.primaryKey) - Number(a.name === data.object.primaryKey)
    );
    return (
        <article className="ps-schema-card">
            {data.incoming.map((id, index) => (
                <Handle
                    key={id}
                    id={id}
                    type="target"
                    position={Position.Left}
                    isConnectable={false}
                    style={{ top: 62 + ((index + 1) / (data.incoming.length + 1)) * 100 }}
                />
            ))}
            <header>
                <ObjectTypeIcon className="ps-schema-object-icon" objectType={data.object} />
                <strong>{data.object.displayName}</strong>
                <span>{properties.length}</span>
            </header>
            <code>{data.object.name}</code>
            <div className="ps-schema-preview">
                {properties.slice(0, 3).map((property) => (
                    <div key={property.name}>
                        <span>
                            {property.name === data.object.primaryKey && (
                                <KeyRound size={11} aria-label="Primary key" />
                            )}
                            {property.displayName}
                        </span>
                        <small title={typeDisplayName(property.type)}>{typeDisplayName(property.type)}</small>
                    </div>
                ))}
            </div>
            {properties.length > 3 && <footer>+{properties.length - 3} properties</footer>}
            {data.outgoing.map((id, index) => (
                <Handle
                    key={id}
                    id={id}
                    type="source"
                    position={Position.Right}
                    isConnectable={false}
                    style={{ top: 62 + ((index + 1) / (data.outgoing.length + 1)) * 100 }}
                />
            ))}
        </article>
    );
}
/** Fit after the host panel's opening animation/resize, not just its initial short height. */
function FitSchemaViewport() {
    const { fitView } = useReactFlow();
    const ready = useNodesInitialized();
    const width = useStore((state) => state.width);
    const height = useStore((state) => state.height);
    useEffect(() => {
        if (!ready || !width || !height) return;
        const frame = requestAnimationFrame(() => {
            void fitView({ padding: 0.06, maxZoom: 1 });
        });
        return () => cancelAnimationFrame(frame);
    }, [ready, width, height, fitView]);
    return null;
}
const nodeTypes = { object: ObjectCard };
export function SchemaView({ ir, theme }: { ir: OntologyIR; theme: "dark" | "light" }) {
    const initial = useMemo(() => {
        const layout = layoutSchema(ir);
        const names = new Set(ir.objectTypes.map((object) => object.name));
        const links = ir.linkTypes
            .filter((link) => names.has(link.source.objectType) && names.has(link.target.objectType))
            .map(schemaRelationship);
        return {
            nodes: layout.nodes.map(({ objectType, x, y }): ObjectNode => ({
                id: objectType.name,
                type: "object",
                position: { x, y },
                ariaLabel: `${objectType.displayName} object type`,
                data: {
                    object: objectType,
                    outgoing: links.filter((link) => link.source === objectType.name).map((link) => link.id),
                    incoming: links.filter((link) => link.target === objectType.name).map((link) => link.id),
                },
            })),
            edges: links.map((link): Edge => ({
                id: link.id,
                source: link.source,
                target: link.target,
                sourceHandle: link.id,
                targetHandle: link.id,
                type: "smoothstep",
                label: link.label,
                ariaLabel: `${link.source} → ${link.target}: ${link.label}`,
                markerEnd: { type: MarkerType.ArrowClosed },
            })),
        };
    }, [ir]);
    return <SchemaCanvas key={JSON.stringify(ir)} ir={ir} theme={theme} initial={initial} />;
}
function SchemaCanvas({
    ir,
    theme,
    initial,
}: {
    ir: OntologyIR;
    theme: "dark" | "light";
    initial: { nodes: ObjectNode[]; edges: Edge[] };
}) {
    const [nodes, setNodes, onNodesChange] = useNodesState<ObjectNode>(initial.nodes);
    const [selected, select] = useState<string>();
    const object = ir.objectTypes.find((type) => type.name === selected);
    if (!ir.objectTypes.length)
        return <div className="ps-schema-empty">This ontology has no object types.</div>;
    return (
        <div className="ps-schema" aria-label="Ontology schema">
            <ReactFlow<ObjectNode, Edge>
                proOptions={{ hideAttribution: true }}
                nodes={nodes}
                edges={initial.edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onSelectionChange={({ nodes: selectedNodes }) => select(selectedNodes[0]?.id)}
                nodesConnectable={false}
                edgesReconnectable={false}
                edgesFocusable={false}
                deleteKeyCode={null}
                fitView
                fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
                minZoom={0.25}
                maxZoom={2}
                colorMode={theme}
                defaultEdgeOptions={{
                    style: { strokeWidth: 1.5 },
                    labelStyle: { fontSize: 10 },
                    labelBgPadding: [6, 4],
                    labelBgBorderRadius: 4,
                }}
            >
                <FitSchemaViewport />
                <Background gap={20} size={1} />
                <Controls showInteractive={false} />
            </ReactFlow>
            {object && (
                <aside className="ps-schema-details" aria-label={`${object.displayName} schema details`}>
                    <header>
                        <button
                            type="button"
                            aria-label="Close schema details"
                            onClick={() => {
                                select(undefined);
                                setNodes((current) => current.map((node) => ({ ...node, selected: false })));
                            }}
                        >
                            <X size={14} />
                        </button>
                        <ObjectTypeIcon className="ps-schema-object-icon" objectType={object} />
                        <strong>{object.displayName}</strong>
                    </header>
                    <div className="ps-schema-detail-body">
                        <code>{object.name}</code>
                        <table aria-label="Object properties">
                            <thead>
                                <tr>
                                    <th>Property</th>
                                    <th>Type</th>
                                </tr>
                            </thead>
                            <tbody>
                                {object.properties.map((property) => (
                                    <tr key={property.name}>
                                        <td>
                                            <span>
                                                {property.name === object.primaryKey && (
                                                    <KeyRound size={12} aria-label="Primary key" />
                                                )}
                                                {property.displayName}
                                            </span>
                                            <code>{property.name}</code>
                                        </td>
                                        <td>{typeDisplayName(property.type)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {ir.linkTypes.some(
                            (link) =>
                                link.source.objectType === object.name ||
                                link.target.objectType === object.name
                        ) && (
                            <>
                                <h4>Relationships</h4>
                                {ir.linkTypes
                                    .filter(
                                        (link) =>
                                            link.source.objectType === object.name ||
                                            link.target.objectType === object.name
                                    )
                                    .map((link) => (
                                        <div className="ps-schema-relationship" key={link.id}>
                                            <strong>
                                                {schemaLinkLabel(
                                                    ir,
                                                    link.source.objectType === object.name
                                                        ? link.target
                                                        : link.source,
                                                    link.source.objectType === object.name
                                                        ? "one"
                                                        : link.cardinality
                                                )}
                                            </strong>
                                            <span>
                                                {link.source.objectType}.{link.foreignKey} →{" "}
                                                {link.target.objectType}
                                            </span>
                                        </div>
                                    ))}
                            </>
                        )}
                    </div>
                </aside>
            )}
        </div>
    );
}
