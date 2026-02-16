import type { LoadSubsetOptions } from "@tanstack/db";

export interface LoadOntologySubsetRequest {
    objectTypeName: string;
    options: LoadSubsetOptions;
}

export interface ExecuteOntologyActionRequest<
    TParameters extends Record<string, unknown> = Record<string, unknown>,
> {
    actionTypeName: string;
    parameters: TParameters;
}

interface BaseOntologyAdapter {
    readonly mode: "unmanaged" | "managed";
    readonly name: string;
    loadSubset<TRecord extends Record<string, unknown>>(
        request: LoadOntologySubsetRequest
    ): Promise<TRecord[]>;
    executeAction<TResult = unknown>(request: ExecuteOntologyActionRequest): Promise<TResult>;
}

export interface UnmanagedOntologyAdapter extends BaseOntologyAdapter {
    readonly mode: "unmanaged";
}

export interface ManagedOntologyAdapter extends BaseOntologyAdapter {
    readonly mode: "managed";
    installOntology(): Promise<void>;
    destroyOntology(): Promise<void>;
}

export type OntologyAdapter = UnmanagedOntologyAdapter | ManagedOntologyAdapter;
