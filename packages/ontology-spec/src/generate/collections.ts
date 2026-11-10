import type { OntologyIR } from "../ir/generated/types.js";
import type { GenerateLiveOpts } from "./live.js";

/** Descriptors resolve against the consuming view's DbClient, never a generated singleton. */
export function generateCollections(
    ir: OntologyIR,
    opts: Pick<GenerateLiveOpts, "ontologyRuntimeImportPath" | "ontologyTypesImportPath" | "ontologyTypeName">
): string {
    const keys = Object.fromEntries(ir.objectTypes.map((type) => [type.name, type.primaryKey]));
    const links: Record<
        string,
        Record<string, { objectType: string; source: string[]; target: string[] }>
    > = {};
    for (const link of ir.linkTypes) {
        if (!link.foreignKey) continue;
        (links[link.source.objectType] ??= {})[link.target.name] = {
            objectType: link.target.objectType,
            source: link.foreignKey.split("."),
            target: [keys[link.target.objectType]!],
        };
        (links[link.target.objectType] ??= {})[link.source.name] = {
            objectType: link.source.objectType,
            source: [keys[link.target.objectType]!],
            target: link.foreignKey.split("."),
        };
    }
    return `import { ontologyCollections } from ${JSON.stringify(opts.ontologyRuntimeImportPath)};
import type { ${opts.ontologyTypeName} } from ${JSON.stringify(opts.ontologyTypesImportPath)};

const linkDefinitions = ${JSON.stringify(links)} as const;
export const { objects, cachedObjects } = ontologyCollections<${opts.ontologyTypeName}, typeof linkDefinitions>(${JSON.stringify(keys)}, linkDefinitions);`;
}
