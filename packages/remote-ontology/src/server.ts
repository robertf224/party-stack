import {
    BaseQueryBuilder,
    queryOnce,
    type Collection,
    type InitialQueryBuilder,
    type QueryBuilder,
    type Context as QueryBuilderContext,
} from "@tanstack/db";
import { createInMemoryBlobStore } from "@party-stack/blobs";
import { createLiveOntology } from "@party-stack/ontology";
import { decode, encode } from "@party-stack/ontology/json";
import type { LiveOntology, OntologyAdapter, OntologyDefinition, OntologyIR } from "@party-stack/ontology";
import type { attachment } from "@party-stack/ontology/values";
import {
    parseRemoteOntologyJson,
    parseRemoteOntologyRequest,
    remoteOntologyEndpointSchema,
    serializeRemoteOntologyJson,
} from "./protocol.js";
import {
    applyFixedActionParameterValues,
    projectRemoteOntologyIR,
    type ClientContextProjectionMode,
    type FixedActionParameterValues,
} from "./securedOntology.js";
import type {
    RemoteApplyActionRequest,
    RemoteApplyActionResponse,
    RemoteAttachmentRequest,
    RemoteAttachmentUpload,
    RemoteDescribeRequest,
    RemoteLoadSubsetRequest,
    RemoteLoadSubsetResponse,
    RemoteRunQueryFunctionRequest,
    RemoteRunQueryFunctionResponse,
    RemoteOntologyEndpoint,
    RemoteOntologyDescription,
    RemoteLoadSubsetOptions,
    RemoteOntologyRequestByEndpoint,
    RemoteOntologyResponseByEndpoint,
} from "./protocol.js";
import type { IR } from "@tanstack/db";

type ObjectTypeName<Ontology extends OntologyDefinition> = Extract<
    keyof Ontology["objectTypes"],
    string
>;

type ObjectTypeObject<
    Ontology extends OntologyDefinition,
    ObjectType extends ObjectTypeName<Ontology>,
> = Ontology["objectTypes"][ObjectType];

type KnownStringKeys<T> = Extract<
    {
        [Key in keyof T]: string extends Key ? never : Key;
    }[keyof T],
    string
>;

type ObjectTypePropertyName<
    Ontology extends OntologyDefinition,
    ObjectType extends ObjectTypeName<Ontology>,
> = KnownStringKeys<ObjectTypeObject<Ontology, ObjectType>>;

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

export type RemoteOntologyBaseObjectTypeQueries<
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

type RemoteOntologyAllowedObjectTypePropertyList<
    Context,
    Ontology extends OntologyDefinition,
    ObjectType extends ObjectTypeName<Ontology>,
> =
    | readonly ObjectTypePropertyName<Ontology, ObjectType>[]
    | ((args: {
          ctx: Context;
          objectType: ObjectType;
          request: RemoteLoadSubsetRequest & { objectType: ObjectType };
      }) => readonly ObjectTypePropertyName<Ontology, ObjectType>[]);

export type RemoteOntologyAllowedObjectTypeProperties<
    Context,
    Ontology extends OntologyDefinition,
> = {
    [ObjectType in ObjectTypeName<Ontology>]?: RemoteOntologyAllowedObjectTypePropertyList<
        Context,
        Ontology,
        ObjectType
    >;
};

export type RemoteOntologyClientContextPolicy<Context> =
    | "forward"
    | ((
          ctx: Context
      ) =>
          | Record<string, unknown>
          | undefined
          | Promise<Record<string, unknown> | undefined>);

export type RemoteOntologyApplyActionRequest<
    Ontology extends OntologyDefinition = OntologyDefinition,
> = {
    [ActionTypeName in Extract<
        keyof Ontology["actionTypes"],
        string
    >]: {
        actionType: ActionTypeName;
        parameters: Ontology["actionTypes"][ActionTypeName]["parameters"];
    };
}[Extract<keyof Ontology["actionTypes"], string>];

export type RemoteOntologyRunQueryFunctionRequest<
    Ontology extends OntologyDefinition = OntologyDefinition,
> = {
    [QueryFunctionTypeName in Extract<
        keyof Ontology["queryFunctionTypes"],
        string
    >]: {
        queryFunctionType: QueryFunctionTypeName;
        parameters: Ontology["queryFunctionTypes"][QueryFunctionTypeName]["parameters"];
    };
}[Extract<keyof Ontology["queryFunctionTypes"], string>];

export interface RemoteOntologyPolicy<
    Context,
    Ontology extends OntologyDefinition = OntologyDefinition,
> {
    baseObjectTypeQueries?: RemoteOntologyBaseObjectTypeQueries<Context, Ontology>;
    allowedObjectTypeProperties?: RemoteOntologyAllowedObjectTypeProperties<Context, Ontology>;
    fixedActionParameterValues?: FixedActionParameterValues<Ontology>;
    clientContext?: RemoteOntologyClientContextPolicy<Context>;
    canApplyAction?: (
        ctx: Context,
        request: RemoteOntologyApplyActionRequest<Ontology>,
        opts: RemoteOntologyCanApplyActionOptions<Ontology>
    ) => boolean | Promise<boolean>;
    canRunQueryFunction?: (
        ctx: Context,
        request: RemoteOntologyRunQueryFunctionRequest<Ontology>,
        opts: RemoteOntologyCanRunQueryOptions<Ontology>
    ) => boolean | Promise<boolean>;
}

export interface CreateRemoteOntologyServerOptions<
    Context = Record<string, unknown>,
    Ontology extends OntologyDefinition = OntologyDefinition,
> {
    ir: OntologyIR | ((ctx: Context) => OntologyIR | Promise<OntologyIR>);
    adapter: OntologyAdapter | ((ctx: Context) => OntologyAdapter | Promise<OntologyAdapter>);
    getContext?: (request: Request) => Context | Promise<Context>;
    policy?: RemoteOntologyPolicy<Context, Ontology>;
}

export interface RemoteOntologyServer {
    handleRequest: (request: Request) => Promise<Response>;
}

export interface RemoteOntologyCanApplyActionOptions<
    Ontology extends OntologyDefinition = OntologyDefinition,
> {
    objects: LiveOntology<Ontology>["objects"];
}

export interface RemoteOntologyCanRunQueryOptions<
    Ontology extends OntologyDefinition = OntologyDefinition,
> {
    objects: LiveOntology<Ontology>["objects"];
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
    const headers = new Headers(init?.headers);
    headers.set("content-type", "application/json");
    return new Response(serializeRemoteOntologyJson(body), {
        ...init,
        headers,
    });
}

function errorResponse(error: unknown, status: number = 500): Response {
    if (status >= 500) {
        console.error("Remote ontology request failed.", error);
    }
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, { status });
}

function getErrorStatus(error: unknown): number {
    if (error instanceof Error && error.name === "RemoteOntologyForbiddenError") return 403;
    return error instanceof Error && error.name === "ZodError" ? 400 : 500;
}

class RemoteOntologyForbiddenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RemoteOntologyForbiddenError";
    }
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

async function waitForLiveOntologyReady(ontology: LiveOntology): Promise<void> {
    await Promise.all(
        Object.values(ontology.objects).map(async (collection) => {
            if (collection.status === "ready") return;
            if (collection.status === "error" || collection.status === "cleaned-up") {
                throw new Error(`Collection "${collection.id}" is ${collection.status}.`);
            }
            await (collection as typeof collection & {
                waitFor: (event: "status:ready") => Promise<unknown>;
            }).waitFor("status:ready");
        })
    );
}

function normalizePath(pathname: string): string {
    return pathname.replace(/\/+$/, "").split("/").pop() ?? "";
}

function parseAttachmentQuery(url: URL): RemoteAttachmentRequest {
    const attachment = url.searchParams.get("attachment");
    if (!attachment) {
        throw new Error("Missing attachment query parameter.");
    }
    return parseRemoteOntologyRequest(
        "attachment-content",
        parseRemoteOntologyJson(attachment)
    ).input as RemoteAttachmentRequest;
}

async function parseRequestBody(
    request: Request,
    endpoint: RemoteOntologyEndpoint
): Promise<{
    input: RemoteOntologyRequestByEndpoint[RemoteOntologyEndpoint];
    uploads: RemoteAttachmentUpload[];
}> {
    const contentType = request.headers.get("content-type") ?? "";
    if (endpoint === "apply-action" && contentType.includes("multipart/form-data")) {
        const formData = await request.formData();
        const payload = formData.get("payload");
        if (typeof payload !== "string") {
            throw new Error("Multipart remote ontology request is missing a payload.");
        }
        const uploads: RemoteAttachmentUpload[] = [];
        for (const [key, value] of formData.entries()) {
            if (!key.startsWith("attachment:") || typeof value === "string") continue;
            const blob = new Blob([await value.arrayBuffer()], { type: value.type });
            uploads.push({
                attachment: { id: key.slice("attachment:".length) },
                blob,
            });
        }
        return {
            input: parseRemoteOntologyRequest(endpoint, parseRemoteOntologyJson(payload)).input,
            uploads,
        };
    }

    return {
        input: parseRemoteOntologyRequest(
            endpoint,
            parseRemoteOntologyJson(await request.text())
        ).input,
        uploads: [],
    };
}

function stripVirtualProps(object: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(object).filter(([key]) => !key.startsWith("$")));
}

function selectProperties(
    object: Record<string, unknown>,
    properties: readonly string[]
): Record<string, unknown> {
    const plainObject = stripVirtualProps(object);
    return Object.fromEntries(
        properties
            .filter((property) => property in plainObject)
            .map((property) => [property, plainObject[property]])
    );
}

function containsAttachmentId(value: unknown, attachmentId: string): boolean {
    if (Array.isArray(value)) {
        return value.some((item) => containsAttachmentId(item, attachmentId));
    }
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return record.id === attachmentId || Object.values(record).some((item) => containsAttachmentId(item, attachmentId));
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
    createBaseQuery: (args: {
        q: InitialQueryBuilder;
        collection: Collection<Record<string, unknown>, string | number>;
    }) => unknown
): Promise<Record<string, unknown>[]> {
    return queryOnce((q) => {
        let query = createBaseQuery({ q, collection }) as QueryBuilder<any>;
        query = applyLoadSubsetOptionsToQuery(query, options, "object");

        return query.select((refs: any) => refs.object);
    });
}

function resolveAllowedObjectTypeProperties<Context, Ontology extends OntologyDefinition>(
    ctx: Context,
    request: RemoteLoadSubsetRequest,
    allowedProperties:
        | RemoteOntologyAllowedObjectTypePropertyList<
              Context,
              Ontology,
              ObjectTypeName<Ontology>
          >
        | undefined
): readonly string[] {
    if (!allowedProperties) return [];
    if (typeof allowedProperties === "function") {
        return allowedProperties({
            ctx,
            objectType: request.objectType as ObjectTypeName<Ontology>,
            request: request as RemoteLoadSubsetRequest & {
                objectType: ObjectTypeName<Ontology>;
            },
        });
    }
    return allowedProperties;
}

function resolveProjectedAllowedObjectTypeProperties<Context, Ontology extends OntologyDefinition>(
    ctx: Context,
    ir: OntologyIR,
    policy: RemoteOntologyPolicy<Context, Ontology> | undefined
): Record<string, readonly string[]> {
    return Object.fromEntries(
        ir.objectTypes.map((objectType) => [
            objectType.name,
            resolveAllowedObjectTypeProperties(
                ctx,
                { objectType: objectType.name },
                policy?.allowedObjectTypeProperties?.[objectType.name as ObjectTypeName<Ontology>] as
                    | RemoteOntologyAllowedObjectTypePropertyList<
                          Context,
                          Ontology,
                          ObjectTypeName<Ontology>
                      >
                    | undefined
            ),
        ])
    );
}

async function resolveClientContext<Context, Ontology extends OntologyDefinition>(
    ctx: Context,
    policy: RemoteOntologyPolicy<Context, Ontology> | undefined
): Promise<{
    context?: Record<string, unknown>;
    mode: ClientContextProjectionMode;
}> {
    if (!policy?.clientContext) return { mode: "none" };
    if (policy.clientContext === "forward") {
        return {
            context: ctx as Record<string, unknown>,
            mode: "forward",
        };
    }
    return {
        context: await policy.clientContext(ctx),
        mode: "projected",
    };
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
    getObjectTypePrimaryKey(ir, request.objectType);

    const adapter = await resolveValue(opts.adapter, ctx);
    const ontology = createLiveOntology<Ontology>({
        ir,
        adapter,
        getContext: () => ctx as Record<string, unknown>,
    });
    try {
        await waitForLiveOntologyReady(ontology);
        const collection = ontology.objects[
            request.objectType as ObjectTypeName<Ontology>
        ] as unknown as Collection<Record<string, unknown>, string | number>;
        const baseObjectTypeQuery = opts.policy?.baseObjectTypeQueries?.[
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
        if (!baseObjectTypeQuery) {
            throw new RemoteOntologyForbiddenError(
                `Object type "${request.objectType}" is not queryable.`
            );
        }

        const allowedProperties = opts.policy?.allowedObjectTypeProperties?.[
            request.objectType as ObjectTypeName<Ontology>
        ] as
            | RemoteOntologyAllowedObjectTypePropertyList<
                  Context,
                  Ontology,
                  ObjectTypeName<Ontology>
              >
            | undefined;
        const selectedProperties = resolveAllowedObjectTypeProperties(ctx, request, allowedProperties);
        const objects = await queryCollectionSubset(collection, request.options, ({ q, collection }) =>
            baseObjectTypeQuery({
                ctx,
                objectType: request.objectType,
                request,
                q,
                collection,
            })
        );

        return {
            objectType: request.objectType,
            objects: objects.map((object) => selectProperties(object, selectedProperties)),
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
    const clientContext = await resolveClientContext(ctx, opts.policy);
    return {
        ir: projectRemoteOntologyIR({
            ir,
            serverContext: ctx,
            clientContext: clientContext.context,
            clientContextMode: clientContext.mode,
            fixedActionParameterValues: opts.policy?.fixedActionParameterValues,
            allowedObjectTypeProperties: resolveProjectedAllowedObjectTypeProperties(ctx, ir, opts.policy),
        }),
        ...(clientContext.context ? { context: clientContext.context } : {}),
    };
}

async function handleApplyAction<
    Context,
    Ontology extends OntologyDefinition = OntologyDefinition,
>(
    ctx: Context,
    opts: CreateRemoteOntologyServerOptions<Context, Ontology>,
    request: RemoteApplyActionRequest,
    uploads: RemoteAttachmentUpload[] = []
): Promise<RemoteApplyActionResponse> {
    const ir = await resolveValue(opts.ir, ctx);
    const adapter = await resolveValue(opts.adapter, ctx);
    const hydratedRequestParameters = decode({
        ir,
        target: { kind: "actionParameters", actionType: request.actionType },
        value: request.parameters,
    }) as Record<string, unknown>;
    const parameters = await applyFixedActionParameterValues({
        ctx,
        actionType: request.actionType,
        parameters: hydratedRequestParameters,
        fixedActionParameterValues: opts.policy?.fixedActionParameterValues,
    });
    const blobStore = createInMemoryBlobStore(`remote-action:${crypto.randomUUID()}`);
    await Promise.all(uploads.map((upload) => blobStore.stage(upload.attachment.id, upload.blob)));
    const ontology = createLiveOntology<Ontology>({
        ir,
        adapter,
        blobStore: () => blobStore,
        getContext: () => ctx as Record<string, unknown>,
    });

    try {
        await waitForLiveOntologyReady(ontology);
        const canApply = await opts.policy?.canApplyAction?.(
            ctx,
            request as RemoteOntologyApplyActionRequest<Ontology>,
            {
                objects: ontology.objects,
            }
        );
        if (canApply !== true) {
            throw new RemoteOntologyForbiddenError(`Action "${request.actionType}" is not allowed.`);
        }

        const action = ontology.actions[request.actionType];
        if (!action) {
            throw new Error(`Unknown action "${request.actionType}".`);
        }
        await action(parameters).mutationFn();
    } finally {
        await ontology.cleanup();
    }

    return {
        invalidatedObjectTypes: ir.objectTypes.map((objectType) => objectType.name),
    };
}

async function handleRunQueryFunction<
    Context,
    Ontology extends OntologyDefinition = OntologyDefinition,
>(
    ctx: Context,
    opts: CreateRemoteOntologyServerOptions<Context, Ontology>,
    request: RemoteRunQueryFunctionRequest
): Promise<RemoteRunQueryFunctionResponse> {
    const ir = await resolveValue(opts.ir, ctx);
    const queryFunctionTypeDef = ir.queryFunctionTypes.find((candidate) => candidate.name === request.queryFunctionType);
    if (!queryFunctionTypeDef) {
        throw new Error(`Unknown query function type "${request.queryFunctionType}".`);
    }

    const adapter = await resolveValue(opts.adapter, ctx);
    const parameters = decode({
        ir,
        target: { kind: "queryFunctionParameters", queryFunctionType: request.queryFunctionType },
        value: request.parameters,
    }) as Record<string, unknown>;
    const ontology = createLiveOntology<Ontology>({
        ir,
        adapter,
        getContext: () => ctx as Record<string, unknown>,
    });

    try {
        await waitForLiveOntologyReady(ontology);
        const canRun = await opts.policy?.canRunQueryFunction?.(
            ctx,
            {
                queryFunctionType: request.queryFunctionType,
                parameters,
            } as RemoteOntologyRunQueryFunctionRequest<Ontology>,
            {
                objects: ontology.objects,
            }
        );
        if (canRun !== true) {
            throw new RemoteOntologyForbiddenError(`Query function type "${request.queryFunctionType}" is not allowed.`);
        }

        const queryFunction = ontology.queryFunctions[request.queryFunctionType];
        if (!queryFunction) {
            throw new Error(`Unknown query function type "${request.queryFunctionType}".`);
        }
        const value = await queryFunction(parameters);
        return {
            value: encode({
                ir,
                target: { kind: "queryFunctionReturn", queryFunctionType: request.queryFunctionType },
                value,
            }),
        };
    } finally {
        await ontology.cleanup();
    }
}

async function handleAttachmentRead<
    Context,
    Ontology extends OntologyDefinition = OntologyDefinition,
>(
    ctx: Context,
    opts: CreateRemoteOntologyServerOptions<Context, Ontology>,
    request: RemoteAttachmentRequest
): Promise<{
    attachment: attachment & { size: number; type: string; name: string };
    blob: Blob;
}> {
    const source = request.attachment.source;
    if (!source) {
        throw new RemoteOntologyForbiddenError("Attachment reads require a source.");
    }

    const ir = await resolveValue(opts.ir, ctx);
    getObjectTypePrimaryKey(ir, source.objectType);
    const adapter = await resolveValue(opts.adapter, ctx);
    if (!adapter.attachments) {
        throw new Error("Remote ontology adapter does not support attachments.");
    }

    const allowedProperties = opts.policy?.allowedObjectTypeProperties?.[
        source.objectType as ObjectTypeName<Ontology>
    ] as
        | RemoteOntologyAllowedObjectTypePropertyList<
              Context,
              Ontology,
              ObjectTypeName<Ontology>
          >
        | undefined;
    const selectedProperties = resolveAllowedObjectTypeProperties(
        ctx,
        { objectType: source.objectType },
        allowedProperties
    );
    if (!selectedProperties.includes(source.property)) {
        throw new RemoteOntologyForbiddenError(
            `Property "${source.property}" on "${source.objectType}" is not readable.`
        );
    }

    const ontology = createLiveOntology<Ontology>({
        ir,
        adapter,
        getContext: () => ctx as Record<string, unknown>,
    });
    try {
        await waitForLiveOntologyReady(ontology);
        const collection = ontology.objects[
            source.objectType as ObjectTypeName<Ontology>
        ] as unknown as Collection<Record<string, unknown>, string | number>;
        const baseObjectTypeQuery = opts.policy?.baseObjectTypeQueries?.[
            source.objectType as ObjectTypeName<Ontology>
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
        if (!baseObjectTypeQuery) {
            throw new RemoteOntologyForbiddenError(
                `Object type "${source.objectType}" is not queryable.`
            );
        }

        const primaryKey = getObjectTypePrimaryKey(ir, source.objectType);
        const objects = await queryCollectionSubset(collection, undefined, ({ q, collection }) =>
            baseObjectTypeQuery({
                ctx,
                objectType: source.objectType,
                request: { objectType: source.objectType },
                q,
                collection,
            })
        );
        const object = objects.find((candidate) => candidate[primaryKey] === source.primaryKey);
        if (!object || !containsAttachmentId(object[source.property], request.attachment.id)) {
            throw new RemoteOntologyForbiddenError("Attachment is not readable.");
        }

        const attachment = await adapter.attachments.getAttachmentMetadata(request.attachment);
        return {
            attachment,
            blob: await adapter.attachments.getAttachmentContent(request.attachment),
        };
    } finally {
        await ontology.cleanup();
    }
}

export function createRemoteOntologyServer<
    Context = Record<string, unknown>,
    Ontology extends OntologyDefinition = OntologyDefinition,
>(opts: CreateRemoteOntologyServerOptions<Context, Ontology>
): RemoteOntologyServer {
    async function handleRpc<TEndpoint extends RemoteOntologyEndpoint>(
        ctx: Context,
        endpoint: TEndpoint,
        input: RemoteOntologyRequestByEndpoint[TEndpoint],
        uploads: RemoteAttachmentUpload[] = []
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
                    input as RemoteApplyActionRequest,
                    uploads
                )) as RemoteOntologyResponseByEndpoint[TEndpoint];
            case "run-query-function":
                return (await handleRunQueryFunction(
                    ctx,
                    opts,
                    input as RemoteRunQueryFunctionRequest
                )) as RemoteOntologyResponseByEndpoint[TEndpoint];
            case "attachment-metadata":
                return (
                    await handleAttachmentRead(
                        ctx,
                        opts,
                        input as RemoteAttachmentRequest
                    )
                ).attachment as RemoteOntologyResponseByEndpoint[TEndpoint];
            case "attachment-content":
                return (
                    await handleAttachmentRead(
                        ctx,
                        opts,
                        input as RemoteAttachmentRequest
                    )
                ).blob as RemoteOntologyResponseByEndpoint[TEndpoint];
        }
    }

    return {
        handleRequest: async (request) => {
            try {
                const url = new URL(request.url);
                const endpoint = remoteOntologyEndpointSchema.parse(normalizePath(url.pathname));
                if (request.method === "GET" && endpoint === "attachment-content") {
                    const ctx = opts.getContext
                        ? await opts.getContext(request)
                        : ({} as Context);
                    const { blob, attachment } = await handleAttachmentRead(
                        ctx,
                        opts,
                        parseAttachmentQuery(url)
                    );
                    return new Response(blob, {
                        headers: {
                            "content-type": attachment.type,
                            "content-length": String(attachment.size),
                        },
                    });
                }

                if (request.method !== "POST") {
                    return errorResponse("Remote ontology endpoints only accept POST requests.", 405);
                }

                const ctx = opts.getContext
                    ? await opts.getContext(request)
                    : ({} as Context);
                const { input, uploads } = await parseRequestBody(request, endpoint);
                const response = await handleRpc(ctx, endpoint, input as never, uploads);
                if (endpoint === "attachment-content") {
                    const blob = response as Blob;
                    return new Response(blob, {
                        headers: {
                            "content-type": blob.type || "application/octet-stream",
                            "content-length": String(blob.size),
                        },
                    });
                }
                return jsonResponse(response);
            } catch (error) {
                return errorResponse(error, getErrorStatus(error));
            }
        },
    };
}
