import type { OntologyIR } from "../ir/generated/types.js";

export interface GenerateLiveOpts {
    ontologyImportPath: string;
    ontologyExportName: string;
    ontologyTypesImportPath: string;
    ontologyByObjectTypeTypeName?: string;
    /** If set, use this link map type for typed related() (e.g. "BlogLinkMap"). Must match linkMapTypeName used in generateTypes. */
    linkMapTypeName?: string;
    liveOntologyImportPath?: string;
    ontologyAdapterImportPath?: string;
    outputTypeName: string;
    outputFactoryName: string;
}

export function generateLive(ir: OntologyIR, opts: GenerateLiveOpts): string {
    const objectTypeNames =
        ir.objectTypes.length === 0 ? "never[]" : `[${ir.objectTypes.map((type) => `"${type.name}"`).join(", ")}] as const`;

    const byObjectTypeTypeName = opts.ontologyByObjectTypeTypeName ?? "OntologyByObjectType";
    const linkMapTypeName = opts.linkMapTypeName;
    const liveOntologyImportPath = opts.liveOntologyImportPath ?? "../../LiveOntology.js";
    const ontologyAdapterImportPath = opts.ontologyAdapterImportPath ?? "../../OntologyAdapter.js";

    const linkMapGeneric = linkMapTypeName ? `, ${linkMapTypeName}` : "";
    const typeParams = `${byObjectTypeTypeName}${linkMapGeneric}`;

    return `import { createLiveOntology, type LiveOntology } from "${liveOntologyImportPath}";
import { ${opts.ontologyExportName} } from "${opts.ontologyImportPath}";
import type { ${byObjectTypeTypeName}${linkMapTypeName ? `, ${linkMapTypeName}` : ""} } from "${opts.ontologyTypesImportPath}";
import type { OntologyAdapter } from "${ontologyAdapterImportPath}";

export const objectTypeNames = ${objectTypeNames};

export type ${opts.outputTypeName} = LiveOntology<${typeParams}>;

export function ${opts.outputFactoryName}(adapter: OntologyAdapter): ${opts.outputTypeName} {
    return createLiveOntology<${typeParams}>({
        ir: ${opts.ontologyExportName},
        adapter,
    });
}
`;
}
