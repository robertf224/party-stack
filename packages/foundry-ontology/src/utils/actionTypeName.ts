import { camelCase, kebabCase } from "change-case";

function mapNamespaceSegments(name: string, convert: (segment: string) => string): string {
    return name.split(".").map(convert).join(".");
}

export function toOntologyActionTypeName(foundryActionTypeName: string): string {
    return mapNamespaceSegments(foundryActionTypeName, camelCase);
}

export function toFoundryActionTypeName(ontologyActionTypeName: string): string {
    return mapNamespaceSegments(ontologyActionTypeName, (segment) =>
        // Preserve each capital as its own Foundry word boundary (BB -> b-b).
        kebabCase(segment.replace(/[A-Z]/g, (character) => `-${character}`))
    );
}
