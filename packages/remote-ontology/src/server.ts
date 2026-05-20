import {
    BaseQueryBuilder,
    queryOnce,
    type Collection,
    type InitialQueryBuilder,
    type QueryBuilder,
    type Context as QueryBuilderContext,
} from "@tanstack/db";
import { createLiveOntology } from "@party-stack/ontology";
import type { OntologyAdapter, OntologyDefinition, OntologyIR } from "@party-stack/ontology";
import {
    parseRemoteOntologyRequest,
    remoteOntologyEndpointSchema,
} from "./index.js";
import type {
    RemoteApplyActionRequest,
    RemoteApplyActionResponse,
    RemoteDescribeRequest,
    RemoteLoadSubsetRequest,
    RemoteLoadSubsetResponse,
    RemoteOntologyEndpoint,
    RemoteOntologyDescription,
    RemoteLoadSubsetOptions,
    RemoteOntologyRequestByEndpoint,
    RemoteOntologyResponseByEndpoint,
} from "./index.js";
import type { IR } from "@tanstack/db";

type ObjectTypeName<Ontology extends OntologyDefinition> = Extract<
    keyof Ontology["objectTypes"],
    string
>;

type ObjectTypeObject<
    Ontology extends OntologyDefinition,
    ObjectType extends ObjectTypeName<Ontology>,
> = Ontology["objectTypes"][ObjectType] & Record<string, unknown>;

export type RemoteOntologyLoadSubsetQuery<TObject extends Record<string, unknown>> = QueryBuilder<
    QueryBuilderContext & {
        baseSchema: {
            object: TObject;
        };
        schema: {
            object: TObject;
        };
        fromSourceName: "object";
    }
>;

export type RemoteOntologyBaseLoadSubsetQueries<
    Context,
    Ontology extends OntologyDefinition,
> = {
    [ObjectType in ObjectTypeName<Ontology>]?: (args: {
        ctx: Context;
        objectType: ObjectType;
        request: RemoteLoadSubsetRequest & { objectType: ObjectType };
        q: InitialQueryBuilder;
        collection: Collection<ObjectTypeObject<Ontology, ObjectType>>;
    }) => RemoteOntologyLoadSubsetQuery<ObjectTypeObject<Ontology, ObjectType>>;
};

export type RemoteOntologyObjectPropertySelectors<
    Context,
    Ontology extends OntologyDefinition,
> = {
    [ObjectType in ObjectTypeName<Ontology>]?: (args: {
        ctx: Context;
        objectType: ObjectType;
        request: RemoteLoadSubsetRequest & { objectType: ObjectType };
    }) => readonly Extract<keyof ObjectTypeObject<Ontology, ObjectType>, string>[];
};

export interface RemoteOntologyPolicy<
    Context,
    Ontology extends OntologyDefinition = OntologyDefinition,
> {
    baseLoadSubsetQuery?: RemoteOntologyBaseLoadSubsetQueries<Context, Ontology>;
    selectObjectProperties?: RemoteOntologyObjectPropertySelectors<Context, Ontology>;
    canApplyAction?: (
        ctx: Context,
        request: RemoteApplyActionRequest
    ) => boolean | Promise<boolean>;
    rewriteActionParameters?: (
        ctx: Context,
        request: RemoteApplyActionRequest
    ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface CreateRemoteOntologyServerOptions<
    Context = Record<string, unknown>,
    Ontology extends OntologyDefinition = OntologyDefinition,
> {
    ir: OntologyIR | ((ctx: Context) => OntologyIR | Promise<OntologyIR>);
    adapter: OntologyAdapter | ((ctx: Context) => OntologyAdapter | Promise<OntologyAdapter>);
    version?: string | ((ctx: Context) => string | Promise<string>);
    getContext?: (request: Request) => Context | Promise<Context>;
    policy?: RemoteOntologyPolicy<Context, Ontology>;
}

export interface RemoteOntologyServer<Context = Record<string, unknown>> {
    handleRequest: (request: Request) => Promise<Response>;
    handleRpc: <TEndpoint extends RemoteOntologyEndpoint>(
        ctx: Context,
        endpoint: TEndpoint,
        input: RemoteOntologyRequestByEndpoint[TEndpoint]
    ) => Promise<RemoteOntologyResponseByEndpoint[TEndpoint]>;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
    const headers = new Headers(init?.headers);
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(body), {
        ...init,
        headers,
    });
}

function errorResponse(error: unknown, status: number = 500): Response {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, { status });
}

function getErrorStatus(error: unknown): number {
    return error instanceof Error && error.name === "ZodError" ? 400 : 500;
}

function getObjectTypePrimaryKey(ir: OntologyIR, objectType: string): string {
    const objectTypeDef = ir.objectTypes.find((candidate) => candidate.name === objectType);
    if (!objectTypeDef) {
        throw new Error(`Unknown ontology object type "${objectType}".`);
    }
    return objectTypeDef.primaryKey;
}

async function resolveValue<Context, TValue>(
    valueOrFactory: TValue | ((ctx: Context) => TValue | Promise<TValue>),
    ctx: Context
): Promise<TValue> {
    if (typeof valueOrFactory === "function") {
        return (valueOrFactory as (ctx: Context) => TValue | Promise<TValue>)(ctx);
    }
    return valueOrFactory;
}

function normalizePath(pathname: string): string {
    return pathname.replace(/\/+$/, "").split("/").pop() ?? "";
}

function stripVirtualProps(object: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(object).filter(([key]) => !key.startsWith("$")));
}

function selectProperties(
    object: Record<string, unknown>,
    properties: readonly string[] | undefined
): Record<string, unknown> {
    const plainObject = stripVirtualProps(object);
    if (!properties) return plainObject;
    return Object.fromEntries(
        properties
            .filter((property) => property in plainObject)
            .map((property) => [property, plainObject[property]])
    );
}

function qualifyExpressionPaths<TExpression extends IR.BasicExpression>(
    expression: TExpression,
    alias: string
): TExpression {
    if (expression.type === "val") {
        return expression;
    }
    if (expression.type === "ref") {
        return {
            ...expression,
            path: expression.path[0] === alias ? expression.path : [alias, ...expression.path],
        } as TExpression;
    }
    return {
        ...expression,
        args: expression.args.map((arg) => qualifyExpressionPaths(arg, alias)),
    } as TExpression;
}

function qualifyOrderByPaths(orderBy: IR.OrderBy | undefined, alias: string): IR.OrderBy | undefined {
    return orderBy?.map((clause) => ({
        ...clause,
        expression: qualifyExpressionPaths(clause.expression, alias),
    }));
}

function applyLoadSubsetOptionsToQuery(
    query: QueryBuilder<any>,
    options: RemoteLoadSubsetOptions | undefined,
    alias: string
): QueryBuilder<any> {
    if (!options) return query;

    const queryIr = (query as unknown as BaseQueryBuilder)._getQuery();
    const where = [
        ...(queryIr.where ?? []),
        ...(options.where ? [qualifyExpressionPaths(options.where, alias)] : []),
        ...(options.cursor?.whereFrom ? [qualifyExpressionPaths(options.cursor.whereFrom, alias)] : []),
    ];
    const orderBy = [
        ...(queryIr.orderBy ?? []),
        ...(qualifyOrderByPaths(options.orderBy, alias) ?? []),
    ];

    return new BaseQueryBuilder({
        ...queryIr,
        ...(where.length > 0 ? { where } : {}),
        ...(orderBy.length > 0 ? { orderBy } : {}),
        limit: options.limit ?? queryIr.limit,
        offset: options.offset ?? queryIr.offset,
    }) as unknown as QueryBuilder<any>;
}

async function queryCollectionSubset(
    collection: Collection<Record<string, unknown>, string | number>,
    options: RemoteLoadSubsetOptions | undefined,
    createBaseQuery?: (args: {
        q: InitialQueryBuilder;
        collection: Collection<Record<string, unknown>, string | number>;
    }) => unknown
): Promise<Record<string, unknown>[]> {
    return queryOnce((q) => {
        let query = (
            createBaseQuery ? createBaseQuery({ q, collection }) : q.from({ object: collection })
        ) as QueryBuilder<any>;
        query = applyLoadSubsetOptionsToQuery(query, options, "object");

        return query.select((refs: any) => refs.object);
    });
}

async function handleLoadSubset<
    Context,
    Ontology extends OntologyDefinition = OntologyDefinition,
>(
    ctx: Context,
    opts: CreateRemoteOntologyServerOptions<Context, Ontology>,
    request: RemoteLoadSubsetRequest
): Promise<RemoteLoadSubsetResponse> {
    const ir = await resolveValue(opts.ir, ctx);
    const version = opts.version ? await resolveValue(opts.version, ctx) : "0";
    getObjectTypePrimaryKey(ir, request.objectType);

    const adapter = await resolveValue(opts.adapter, ctx);
    const ontology = createLiveOntology<Ontology>({ ir, adapter });
    try {
        const collection = ontology.objects[
            request.objectType as ObjectTypeName<Ontology>
        ] as unknown as Collection<Record<string, unknown>, string | number>;
        const baseLoadSubsetQuery = opts.policy?.baseLoadSubsetQuery?.[
            request.objectType as ObjectTypeName<Ontology>
        ] as
            | ((
                  args: {
                      ctx: Context;
                      objectType: string;
                      request: RemoteLoadSubsetRequest;
                      q: InitialQueryBuilder;
                      collection: Collection<Record<string, unknown>, string | number>;
                  }
              ) => RemoteOntologyLoadSubsetQuery<Record<string, unknown>>)
            | undefined;
        const selectObjectProperties = opts.policy?.selectObjectProperties?.[
            request.objectType as ObjectTypeName<Ontology>
        ] as
            | ((
                  args: {
                      ctx: Context;
                      objectType: string;
                      request: RemoteLoadSubsetRequest;
                  }
              ) => readonly string[])
            | undefined;
        const selectedProperties = selectObjectProperties?.({
            ctx,
            objectType: request.objectType,
            request,
        });
        const objects = await queryCollectionSubset(collection, request.options, ({ q, collection }) =>
            baseLoadSubsetQuery
                ? baseLoadSubsetQuery({
                    ctx,
                    objectType: request.objectType,
                    request,
                    q,
                    collection,
                })
                : q.from({ object: collection })
        );

        return {
            objectType: request.objectType,
            objects: objects.map((object) => selectProperties(object, selectedProperties)),
            version,
        };
    } finally {
        await ontology.cleanup();
    }
}

async function handleDescribe<
    Context,
    Ontology extends OntologyDefinition = OntologyDefinition,
>(
    ctx: Context,
    opts: CreateRemoteOntologyServerOptions<Context, Ontology>,
    _request: RemoteDescribeRequest
): Promise<RemoteOntologyDescription> {
    const ir = await resolveValue(opts.ir, ctx);
    const version = opts.version ? await resolveValue(opts.version, ctx) : "0";
    return {
        ir,
        version,
    };
}

async function handleApplyAction<
    Context,
    Ontology extends OntologyDefinition = OntologyDefinition,
>(
    ctx: Context,
    opts: CreateRemoteOntologyServerOptions<Context, Ontology>,
    request: RemoteApplyActionRequest
): Promise<RemoteApplyActionResponse> {
    const canApply = await opts.policy?.canApplyAction?.(ctx, request);
    if (canApply === false) {
        throw new Error(`Action "${request.actionType}" is not allowed.`);
    }

    const ir = await resolveValue(opts.ir, ctx);
    const version = opts.version ? await resolveValue(opts.version, ctx) : "0";
    const adapter = await resolveValue(opts.adapter, ctx);
    const parameters =
        (await opts.policy?.rewriteActionParameters?.(ctx, request)) ?? request.parameters;
    const ontology = createLiveOntology<Ontology>({ ir, adapter });

    try {
        const action = ontology.actions[request.actionType];
        if (!action) {
            throw new Error(`Unknown action "${request.actionType}".`);
        }
        await action(parameters).mutationFn();
    } finally {
        await ontology.cleanup();
    }

    return {
        version,
        invalidatedObjectTypes: ir.objectTypes.map((objectType) => objectType.name),
    };
}

export function createRemoteOntologyServer<
    Context = Record<string, unknown>,
    Ontology extends OntologyDefinition = OntologyDefinition,
>(opts: CreateRemoteOntologyServerOptions<Context, Ontology>
): RemoteOntologyServer<Context> {
    async function handleRpc<TEndpoint extends RemoteOntologyEndpoint>(
        ctx: Context,
        endpoint: TEndpoint,
        input: RemoteOntologyRequestByEndpoint[TEndpoint]
    ): Promise<RemoteOntologyResponseByEndpoint[TEndpoint]> {
        switch (endpoint) {
            case "describe":
                return (await handleDescribe(
                    ctx,
                    opts,
                    input as RemoteDescribeRequest
                )) as RemoteOntologyResponseByEndpoint[TEndpoint];
            case "load-subset":
                return (await handleLoadSubset(
                    ctx,
                    opts,
                    input as RemoteLoadSubsetRequest
                )) as RemoteOntologyResponseByEndpoint[TEndpoint];
            case "apply-action":
                return (await handleApplyAction(
                    ctx,
                    opts,
                    input as RemoteApplyActionRequest
                )) as RemoteOntologyResponseByEndpoint[TEndpoint];
        }
    }

    return {
        handleRpc,
        handleRequest: async (request) => {
            try {
                if (request.method !== "POST") {
                    return errorResponse("Remote ontology endpoints only accept POST requests.", 405);
                }

                const ctx = opts.getContext
                    ? await opts.getContext(request)
                    : ({} as Context);
                const endpoint = remoteOntologyEndpointSchema.parse(
                    normalizePath(new URL(request.url).pathname)
                );
                const envelope = parseRemoteOntologyRequest(endpoint, await request.json());
                return jsonResponse(await handleRpc(ctx, envelope.endpoint, envelope.input as never));
            } catch (error) {
                return errorResponse(error, getErrorStatus(error));
            }
        },
    };
}
