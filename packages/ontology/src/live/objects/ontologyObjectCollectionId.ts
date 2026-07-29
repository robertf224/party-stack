export function ontologyObjectCollectionId(owner: string, ontologyId: string, objectType: string): string {
    return `party-stack:${owner}:${ontologyId}:objects:${objectType}`;
}
