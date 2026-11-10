export interface ValidationIssue {
    readonly message: string;
    readonly path?: readonly (string | number)[];
    readonly code?: string;
    readonly category?: "input" | "reference" | "custom";
    readonly source?: "parameter" | "submission" | "user-facing";
    readonly messageSource?: "standard" | "configured";
}
