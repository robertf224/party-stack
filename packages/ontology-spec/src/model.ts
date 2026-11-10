export type OntologyObject = Record<string, unknown>;

export interface OntologyDefinition {
    context?: Record<string, unknown>;
    objectTypes: Record<string, OntologyObject>;
    actionTypes: Record<
        string,
        {
            parameters: Record<string, unknown>;
            /** SDK input convenience; persisted/protocol parameters remain handle-only. */
            inputParameters?: Record<string, unknown>;
            returnType?: unknown;
        }
    >;
    queryFunctionTypes: Record<
        string,
        {
            parameters: Record<string, unknown>;
            returnType: unknown;
        }
    >;
}
