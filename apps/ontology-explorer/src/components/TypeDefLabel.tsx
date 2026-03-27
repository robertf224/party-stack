import { Link } from "@tanstack/react-router";
import type { TypeDef } from "@party-stack/ontology";

export function TypeDefLabel({ type }: { type: TypeDef }) {
    switch (type.kind) {
        case "string":
            return <span className="text-emerald-400">String</span>;
        case "boolean":
            return <span className="text-sky-400">Boolean</span>;
        case "integer":
            return <span className="text-violet-400">Integer</span>;
        case "float":
            return <span className="text-violet-400">Float</span>;
        case "double":
            return <span className="text-violet-400">Double</span>;
        case "date":
            return <span className="text-amber-400">Date</span>;
        case "timestamp":
            return <span className="text-amber-400">Timestamp</span>;
        case "geopoint":
            return <span className="text-rose-400">GeoPoint</span>;
        case "attachment":
            return <span className="text-zinc-400">Attachment</span>;
        case "unknown":
            return <span className="text-zinc-500">Unknown</span>;
        case "list":
            return (
                <span>
                    <span className="text-zinc-500">List&lt;</span>
                    <TypeDefLabel type={type.value.elementType} />
                    <span className="text-zinc-500">&gt;</span>
                </span>
            );
        case "map":
            return (
                <span>
                    <span className="text-zinc-500">Map&lt;</span>
                    <TypeDefLabel type={type.value.keyType} />
                    <span className="text-zinc-500">, </span>
                    <TypeDefLabel type={type.value.valueType} />
                    <span className="text-zinc-500">&gt;</span>
                </span>
            );
        case "struct":
            return (
                <span className="text-teal-400" title={type.value.fields.map((f) => f.name).join(", ")}>
                    Struct
                </span>
            );
        case "union":
            return (
                <span className="text-indigo-400" title={type.value.variants.map((v) => v.name).join(" | ")}>
                    Union
                </span>
            );
        case "optional":
            return (
                <span>
                    <TypeDefLabel type={type.value.type} />
                    <span className="text-zinc-600">?</span>
                </span>
            );
        case "result":
            return <span className="text-orange-400">Result</span>;
        case "ref":
            return <span className="text-cyan-400">{type.value.name}</span>;
        case "objectReference":
            return (
                <Link
                    to="/object-types/$objectType"
                    params={{ objectType: type.value.objectType }}
                    className="text-blue-400 hover:text-blue-300 hover:underline"
                >
                    &rarr; {type.value.objectType}
                </Link>
            );
    }
}

export function typeDefToString(type: TypeDef): string {
    switch (type.kind) {
        case "string":
            return "String";
        case "boolean":
            return "Boolean";
        case "integer":
            return "Integer";
        case "float":
            return "Float";
        case "double":
            return "Double";
        case "date":
            return "Date";
        case "timestamp":
            return "Timestamp";
        case "geopoint":
            return "GeoPoint";
        case "attachment":
            return "Attachment";
        case "unknown":
            return "Unknown";
        case "list":
            return `List<${typeDefToString(type.value.elementType)}>`;
        case "map":
            return `Map<${typeDefToString(type.value.keyType)}, ${typeDefToString(type.value.valueType)}>`;
        case "struct":
            return "Struct";
        case "union":
            return "Union";
        case "optional":
            return `${typeDefToString(type.value.type)}?`;
        case "result":
            return "Result";
        case "ref":
            return type.value.name;
        case "objectReference":
            return `→ ${type.value.objectType}`;
    }
}
