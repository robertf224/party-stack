import type { OntologyIR } from "../ir/generated/types.js";

/** Partitioning never selects credentials or grants authority. Defaults preserve existing account ownership. */
export function contextPartition(ir: OntologyIR, context: Record<string, unknown>): string {
    const paths = ir.context?.partition;
    if (!paths) return typeof context.user === "string" ? context.user : "anonymous";
    if (!paths.length) throw new TypeError("Context partition requires at least one path.");
    const parts = paths.map((path) => {
        if (!path.length) throw new TypeError("Context partition path is empty.");
        let value: unknown = context;
        for (const part of path) {
            if (!part || value === null || typeof value !== "object" || !Object.hasOwn(value, part))
                throw new TypeError("A configured partition component is unavailable.");
            value = Reflect.get(value, part);
        }
        if (
            typeof value !== "string" &&
            typeof value !== "boolean" &&
            !(typeof value === "number" && Number.isFinite(value))
        )
            throw new TypeError("Partition components must be stable scalar identities.");
        return [path, typeof value, value];
    });
    if (new Set(paths.map((p) => JSON.stringify(p))).size !== paths.length)
        throw new TypeError("Partition paths must be distinct.");
    return `context:${JSON.stringify(parts)}`;
}
