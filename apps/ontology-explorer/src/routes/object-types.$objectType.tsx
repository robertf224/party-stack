import { eq, ilike, or, useLiveQuery } from "@tanstack/react-db";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
    useTable,
    tableFeatures,
    rowSortingFeature,
    columnSizingFeature,
    columnResizingFeature,
    flexRender,
    type ColumnDef,
    type SortingState,
    type ColumnSizingState,
} from "@tanstack/react-table";
import { useDeferredValue, useMemo, useRef, useState } from "react";
import { TypeDefLabel } from "../components/TypeDefLabel";
import { useOntology } from "../ontology/OntologyProvider";
import type { PropertyDef, TypeDef } from "@party-stack/ontology";

const objectTableFeatures = tableFeatures({ rowSortingFeature, columnSizingFeature, columnResizingFeature });

export const Route = createFileRoute("/object-types/$objectType")({
    component: ObjectTypeDetail,
});

function ObjectTypeDetail() {
    const { meta, data } = useOntology();
    const { objectType: objectTypeName } = Route.useParams();

    const { data: objectType } = useLiveQuery(
        (q) =>
            q
                .from({ ot: meta.objects.ObjectType })
                .where(({ ot }) => eq(ot.name, objectTypeName))
                .select(({ ot }) => ({ ...ot }))
                .findOne(),
        [objectTypeName]
    );

    if (!objectType) {
        return (
            <div className="flex items-center justify-center p-16 text-zinc-500">Loading object type...</div>
        );
    }

    const properties = objectType.properties as PropertyDef[];
    const collection = data?.objects[objectTypeName] ?? null;

    return (
        <div className="mx-auto max-w-6xl p-8">
            <div className="mb-8">
                <div className="flex items-center gap-3">
                    <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-300">
                        ← Back
                    </Link>
                </div>
                <h1 className="mt-3 text-2xl font-bold text-zinc-100">{objectType.displayName as string}</h1>
                <div className="mt-1 flex items-center gap-3 text-sm text-zinc-400">
                    <span className="font-mono text-xs">{objectType.name as string}</span>
                    <span className="text-zinc-600">·</span>
                    <span>
                        Primary key: <code className="text-zinc-300">{objectType.primaryKey as string}</code>
                    </span>
                </div>
                {objectType.description && (
                    <p className="mt-2 text-sm text-zinc-400">{objectType.description as string}</p>
                )}
            </div>

            <section className="mb-10">
                <h2 className="mb-4 text-lg font-semibold text-zinc-200">Properties</h2>
                <div className="overflow-hidden rounded-xl border border-zinc-800">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-zinc-800 bg-zinc-900/50">
                                <th className="px-4 py-2.5 text-left font-medium text-zinc-400">Name</th>
                                <th className="px-4 py-2.5 text-left font-medium text-zinc-400">API Name</th>
                                <th className="px-4 py-2.5 text-left font-medium text-zinc-400">Type</th>
                                <th className="px-4 py-2.5 text-left font-medium text-zinc-400">
                                    Description
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800/60">
                            {properties.map((prop) => (
                                <tr key={prop.name} className="hover:bg-zinc-900/30">
                                    <td className="px-4 py-2 font-medium text-zinc-200">
                                        {prop.displayName}
                                        {prop.name === objectType.primaryKey && (
                                            <span className="ml-2 rounded bg-blue-900/40 px-1.5 py-0.5 text-[10px] text-blue-300">
                                                PK
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-4 py-2 font-mono text-xs text-zinc-400">{prop.name}</td>
                                    <td className="px-4 py-2 font-mono text-xs">
                                        <TypeDefLabel type={prop.type} />
                                    </td>
                                    <td className="px-4 py-2 text-zinc-500">{prop.description ?? "—"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            <section>
                <h2 className="mb-4 text-lg font-semibold text-zinc-200">
                    {objectType.pluralDisplayName as string}
                </h2>
                {collection ? (
                    <ObjectInstanceTable
                        collection={collection}
                        properties={properties}
                        primaryKey={objectType.primaryKey as string}
                    />
                ) : (
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-500">
                        Loading ontology data...
                    </div>
                )}
            </section>
        </div>
    );
}

function defaultColumnSize(prop: PropertyDef): number {
    const kind = prop.type.kind === "optional" ? prop.type.value.type.kind : prop.type.kind;
    switch (kind) {
        case "boolean":
            return 90;
        case "integer":
        case "float":
        case "double":
            return 120;
        case "date":
            return 140;
        case "timestamp":
            return 200;
        case "geopoint":
            return 180;
        case "string":
        case "objectReference":
        default:
            return 200;
    }
}

function isStringType(type: TypeDef): boolean {
    if (type.kind === "string") return true;
    if (type.kind === "optional") return isStringType(type.value.type);
    return false;
}

function ObjectInstanceTable({
    collection,
    properties,
    primaryKey,
}: {
    collection: ReturnType<typeof useOntology>["data"] extends null
        ? never
        : NonNullable<ReturnType<typeof useOntology>["data"]>["objects"][string];
    properties: PropertyDef[];
    primaryKey: string;
}) {
    const [sorting, setSorting] = useState<SortingState>([]);
    const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
    const [filterInput, setFilterInput] = useState("");
    const filter = useDeferredValue(filterInput);
    const isFilterPending = filterInput !== filter;

    const stringPropNames = useMemo(
        () => properties.filter((p) => isStringType(p.type)).map((p) => p.name),
        [properties]
    );

    const sortField = sorting[0]?.id ?? primaryKey;
    const sortDir = (sorting[0]?.desc ? "desc" : "asc") as "asc" | "desc";

    const { data: rows } = useLiveQuery(
        (q) => {
            let query = q.from({ obj: collection });

            if (filter && stringPropNames.length > 0) {
                const pattern = `${filter}%`;
                query = query.where(({ obj }) => {
                    const ref = obj as Record<string, any>;
                    const conditions = stringPropNames.map((name) => ilike(ref[name], pattern));
                    return conditions.length === 1
                        ? conditions[0]!
                        : (or as (...args: any[]) => any)(...conditions);
                });
            }

            return query
                .select(({ obj }) => ({ ...obj }))
                .orderBy(({ obj }) => obj[sortField], sortDir)
                .limit(50);
        },
        [filter, stringPropNames, sortField, sortDir]
    );

    const columns = useMemo<ColumnDef<typeof objectTableFeatures, Record<string, unknown>>[]>(
        () =>
            properties.map((prop) => ({
                id: prop.name,
                header: prop.displayName,
                accessorFn: (row: Record<string, unknown>) => row[prop.name],
                cell: (cell) => {
                    const value = cell.getValue();
                    return <CellValue value={value} type={prop.type} />;
                },
                size: defaultColumnSize(prop),
                minSize: 80,
                maxSize: 600,
            })),
        [properties]
    );

    const data = useMemo(
        () => (rows as unknown as Record<string, unknown>[]).map((row) => ({ ...row })),
        [rows]
    );

    const table = useTable({
        features: objectTableFeatures,
        data,
        columns,
        state: { sorting, columnSizing },
        onSortingChange: setSorting,
        onColumnSizingChange: setColumnSizing,
        columnResizeMode: "onEnd",
        manualSorting: true,
    });

    const columnSizeVars = (() => {
        const headers = table.getFlatHeaders();
        const vars: Record<string, string> = {};
        for (const header of headers) {
            vars[`--header-${header.id}-size`] = `${header.getSize()}px`;
            vars[`--col-${header.column.id}-size`] = `${header.column.getSize()}px`;
        }
        return vars;
    })();

    const scrollRef = useRef<HTMLDivElement>(null);

    return (
        <div>
            <div className="mb-3 flex items-center gap-3">
                <input
                    className="w-full max-w-sm rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-zinc-600"
                    placeholder="Search across text fields..."
                    value={filterInput}
                    onChange={(e) => setFilterInput(e.target.value)}
                />
                {isFilterPending && <span className="text-xs text-zinc-500">Searching...</span>}
            </div>
            <div ref={scrollRef} className="max-h-[600px] overflow-auto rounded-xl border border-zinc-800">
                <table
                    className={`text-sm transition-opacity duration-150 ${isFilterPending ? "opacity-60" : ""}`}
                    style={
                        {
                            ...columnSizeVars,
                            width: table.getTotalSize(),
                            minWidth: "100%",
                            tableLayout: "fixed",
                        } as React.CSSProperties
                    }
                >
                    <thead className="sticky top-0 z-10">
                        {table.getHeaderGroups().map((headerGroup) => (
                            <tr key={headerGroup.id} className="border-b border-zinc-800 bg-zinc-900">
                                {headerGroup.headers.map((header) => (
                                    <th
                                        aria-sort={
                                            header.column.getIsSorted() === "asc"
                                                ? "ascending"
                                                : header.column.getIsSorted() === "desc"
                                                  ? "descending"
                                                  : "none"
                                        }
                                        key={header.id}
                                        className="relative text-left font-medium text-zinc-400 select-none"
                                        style={{ width: `var(--header-${header.id}-size)` }}
                                    >
                                        <button
                                            type="button"
                                            disabled={!header.column.getCanSort()}
                                            className="flex w-full cursor-pointer items-center gap-1 truncate px-4 py-2.5 text-left outline-none hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-default"
                                            onClick={header.column.getToggleSortingHandler()}
                                            title={
                                                typeof header.column.columnDef.header === "string"
                                                    ? header.column.columnDef.header
                                                    : undefined
                                            }
                                        >
                                            <span className="truncate">
                                                {flexRender(
                                                    header.column.columnDef.header,
                                                    header.getContext()
                                                )}
                                            </span>
                                            {header.column.getIsSorted() === "asc" && (
                                                <span className="shrink-0">↑</span>
                                            )}
                                            {header.column.getIsSorted() === "desc" && (
                                                <span className="shrink-0">↓</span>
                                            )}
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={`Resize ${header.column.id} column`}
                                            onKeyDown={(event) => {
                                                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                                                    return;
                                                event.preventDefault();
                                                const delta = event.key === "ArrowRight" ? 10 : -10;
                                                const min = header.column.columnDef.minSize ?? 20;
                                                const max =
                                                    header.column.columnDef.maxSize ??
                                                    Number.MAX_SAFE_INTEGER;
                                                setColumnSizing((current) => ({
                                                    ...current,
                                                    [header.column.id]: Math.min(
                                                        max,
                                                        Math.max(min, header.column.getSize() + delta)
                                                    ),
                                                }));
                                            }}
                                            onDoubleClick={() => header.column.resetSize()}
                                            onMouseDown={header.getResizeHandler()}
                                            onTouchStart={header.getResizeHandler()}
                                            className={`absolute top-0 right-0 h-full w-1 cursor-col-resize touch-none border-0 p-0 outline-none select-none focus-visible:bg-blue-500 ${
                                                header.column.getIsResizing()
                                                    ? "bg-blue-500"
                                                    : "bg-transparent hover:bg-zinc-600"
                                            }`}
                                            style={{
                                                transform: header.column.getIsResizing()
                                                    ? `translateX(${table.state.columnResizing.deltaOffset ?? 0}px)`
                                                    : undefined,
                                            }}
                                        />
                                    </th>
                                ))}
                            </tr>
                        ))}
                    </thead>
                    <tbody className="divide-y divide-zinc-800/60">
                        {table.getRowModel().rows.length === 0 && (
                            <tr>
                                <td colSpan={columns.length} className="px-4 py-8 text-center text-zinc-500">
                                    {rows.length === 0
                                        ? filter
                                            ? "No matching records"
                                            : "Loading data..."
                                        : "No matching records"}
                                </td>
                            </tr>
                        )}
                        {table.getRowModel().rows.map((row) => (
                            <tr key={row.id} className="hover:bg-zinc-900/30">
                                {row.getAllCells().map((cell) => (
                                    <td
                                        key={cell.id}
                                        className="truncate px-4 py-2 text-zinc-300"
                                        style={{ width: `var(--col-${cell.column.id}-size)` }}
                                    >
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="mt-2 text-xs text-zinc-500">Showing {data.length} rows</div>
        </div>
    );
}

function CellValue({ value, type }: { value: unknown; type: TypeDef }) {
    if (value === null || value === undefined) {
        return <span className="text-zinc-600">—</span>;
    }

    if (type.kind === "objectReference" && typeof value === "string") {
        return (
            <Link
                to="/object-types/$objectType"
                params={{ objectType: type.value.objectType }}
                className="text-blue-400 hover:text-blue-300 hover:underline"
            >
                {value}
            </Link>
        );
    }

    if (
        (type.kind === "timestamp" || type.kind === "date") &&
        (typeof value === "string" ||
            (typeof value === "object" &&
                "toString" in value &&
                typeof value.toString === "function" &&
                value.toString !== Object.prototype.toString))
    ) {
        return <span className="tabular-nums">{(value as { toString(): string }).toString()}</span>;
    }

    if (type.kind === "geopoint" && typeof value === "object") {
        const geo = value as { lat: number; lon: number };
        return (
            <span className="text-xs tabular-nums">
                {geo.lat.toFixed(4)}, {geo.lon.toFixed(4)}
            </span>
        );
    }

    if (type.kind === "boolean") {
        return <span>{value ? "✓" : "✗"}</span>;
    }

    if (typeof value === "object") {
        return <span className="text-xs text-zinc-500">{JSON.stringify(value)}</span>;
    }

    if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint" ||
        typeof value === "symbol"
    ) {
        return <span>{String(value)}</span>;
    }
    return <span className="text-zinc-600">—</span>;
}
