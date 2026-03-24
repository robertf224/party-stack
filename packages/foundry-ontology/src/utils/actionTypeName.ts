import { camelCase, kebabCase } from "change-case";

export function toOntologyActionTypeName(foundryActionTypeName: string): string {
    return camelCase(foundryActionTypeName);
}

export function toFoundryActionTypeName(ontologyActionTypeName: string): string {
    return kebabCase(ontologyActionTypeName);
}
