export interface ValidationIssue {
    readonly message: string;
    readonly path?: readonly (string | number)[];
}
