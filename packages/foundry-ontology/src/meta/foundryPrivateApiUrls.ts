function normalizePath(path: string): string {
    return path.replace(/^\/+/, "");
}

/** Builds a Foundry private/API URL from an install base URL without leaking OSDK client internals. */
export function getFoundryPrivateApiUrl(baseUrl: string, path: string): URL {
    return new URL(normalizePath(path), `${new URL(baseUrl).origin}/`);
}

export function getOntologyMetadataBulkLoadEntitiesUrl(baseUrl: string): URL {
    return getFoundryPrivateApiUrl(
        baseUrl,
        "/ontology-metadata/api/ontology/ontology/bulkLoadEntities"
    );
}
