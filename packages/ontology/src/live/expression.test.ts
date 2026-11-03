import { BackendError } from "@party-stack/ontology-backend";
import { actionExpressions } from "@party-stack/ontology-backend/actions";
import { o } from "@party-stack/ontology-spec";
import { getAtPath } from "@party-stack/ontology-spec/utils";
import { eq } from "@tanstack/db";
import { queryOnce, createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { createReadTx } from "./mutators/createReadTx.js";
import type { OntologyReadTx } from "./mutators/types.js";
import type { ActionRequest } from "@party-stack/ontology-backend";
import type { OwnedReadTransaction } from "@party-stack/ontology-backend/owned";
import type { Expression, OntologyIR } from "@party-stack/ontology-spec";
import type { OntologyObject } from "@party-stack/ontology-spec";
import type { Field } from "@party-stack/ontology-storage";

type ExpressionReplay = NonNullable<ActionRequest["replay"]>;
const failure = (cause: unknown) =>
    cause instanceof BackendError
        ? cause
        : new BackendError({
              operation: "expression.evaluate",
              kind: "Internal",
              retryable: false,
              message: "Expression evaluation failed.",
              cause,
          });
const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: failure });
/** Compatibility with the application's TanStack query authoring interface; execution is shared below. */
const reader = (ir: OntologyIR, tx: OntologyReadTx): OwnedReadTransaction => ({
    get: (name, key) =>
        attempt(() =>
            tx.query((query, objects) =>
                query
                    .from({ object: objects[name]! })
                    .where(({ object }) =>
                        eq(object[ir.objectTypes.find((t) => t.name === name)!.primaryKey], key)
                    )
                    .findOne()
            )
        ),
    loadSubset: (name, scan) =>
        Effect.gen(function* () {
            const where = scan?.where;
            if (
                where &&
                (where.op !== "eq" ||
                    !where.left ||
                    typeof where.left !== "object" ||
                    !("_tag" in where.left))
            )
                return yield* new BackendError({
                    operation: "expression.read",
                    kind: "NotImplemented",
                    retryable: false,
                    message: "The authoring read bridge requires an equality lookup.",
                });
            const rows = yield* attempt(() =>
                tx.query<Record<string, unknown>[]>((query, objects) => {
                    const source = query.from({ object: objects[name]! });
                    const filtered =
                        where?.op === "eq" &&
                        where.left &&
                        typeof where.left === "object" &&
                        "_tag" in where.left
                            ? source.where(({ object }) =>
                                  eq(getAtPath(object, (where.left as Field).path), where.right)
                              )
                            : source;
                    return scan?.limit === undefined
                        ? filtered
                        : filtered
                              .orderBy(
                                  ({ object }) =>
                                      object[ir.objectTypes.find((t) => t.name === name)!.primaryKey]
                              )
                              .limit(scan.limit);
                })
            );
            const pk = ir.objectTypes.find((t) => t.name === name)!.primaryKey;
            return rows.map((value) => ({ key: value[pk] as string | number, value }));
        }),
});
const evaluateExpression = (options: {
    readonly ir: OntologyIR;
    readonly actionTypeName: string;
    readonly expression: Expression;
    readonly replay?: ExpressionReplay;
    readonly location?: readonly (string | number)[];
    readonly resolveParameter: (name: string) => Promise<unknown>;
    readonly context: Record<string, unknown>;
    readonly tx: OntologyReadTx;
}): Promise<unknown> =>
    Effect.runPromise(
        actionExpressions({
            ir: options.ir,
            tx: reader(options.ir, options.tx),
            request: {
                id: options.replay?.seed ?? "expression",
                name: options.actionTypeName,
                parameters: {},
                replay: options.replay,
            },
            context: options.context,
            resolveParameter: (name) => attempt(() => options.resolveParameter(name)),
        }).evaluate(options.expression, options.location)
    );

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "User",
            displayName: "User",
            pluralDisplayName: "Users",
            primaryKey: "id",
            properties: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
                {
                    name: "name",
                    displayName: "Name",
                    type: o.string({}),
                },
            ],
        },
    ],
    actionTypes: [
        {
            name: "assign",
            displayName: "Assign",
            parameters: [
                {
                    name: "user",
                    displayName: "User",
                    type: o.objectReference({
                        objectType: "User",
                    }),
                },
                {
                    name: "entries",
                    displayName: "Entries",
                    type: o.list({
                        elementType: o.struct({
                            fields: [
                                {
                                    name: "code",
                                    displayName: "Code",
                                    type: o.string({}),
                                },
                            ],
                        }),
                    }),
                },
            ],
            logic: [],
        },
    ],
};

describe("evaluateExpression", () => {
    it("resolves explicit object lookups through the read transaction", async () => {
        const users = createCollection(
            localOnlyCollectionOptions<OntologyObject, string | number>({
                id: "expression-users",
                getKey: (user) => user.id as string | number,
                initialData: [
                    {
                        id: "user-1",
                        name: "Ada",
                    },
                ],
            })
        );
        await queryOnce((q) => q.from({ row: users }));

        await expect(
            evaluateExpression({
                ir,
                actionTypeName: "assign",
                expression: {
                    kind: "getAt",
                    value: {
                        source: {
                            kind: "lookup",
                            value: {
                                reference: {
                                    kind: "inputReference",
                                    value: { name: "user" },
                                },
                            },
                        },
                        path: ["name"],
                    },
                },
                resolveParameter: () => Promise.resolve("user-1"),
                context: {},
                tx: createReadTx({ User: users }),
            })
        ).resolves.toBe("Ada");

        await users.cleanup();
    });

    it("fetches an explicit lookup when the referenced object is not loaded", async () => {
        const loadSubset = vi.fn();
        const users = createCollection<OntologyObject, string | number>({
            id: "expression-remote-users",
            getKey: (user) => user.id as string,
            syncMode: "on-demand",
            sync: {
                sync: ({ begin, write, commit, markReady }) => {
                    markReady();
                    return {
                        loadSubset: () => {
                            loadSubset();
                            begin();
                            write({ type: "insert", value: { id: "user-1", name: "Ada" } });
                            return commit();
                        },
                    };
                },
            },
        });
        try {
            expect(users.has("user-1")).toBe(false);
            await expect(
                evaluateExpression({
                    ir,
                    actionTypeName: "assign",
                    expression: o.Expression.getAt({
                        source: o.Expression.lookup({
                            reference: o.Expression.inputReference({ name: "user" }),
                        }),
                        path: ["name"],
                    }),
                    resolveParameter: () => Promise.resolve("user-1"),
                    context: {},
                    tx: createReadTx({ User: users }),
                })
            ).resolves.toBe("Ada");
            expect(loadSubset).toHaveBeenCalledOnce();
        } finally {
            await users.cleanup();
        }
    });

    it("returns an object-reference input without implicitly loading it", async () => {
        const query = () => {
            throw new Error("The object collection should not be queried.");
        };

        await expect(
            evaluateExpression({
                ir,
                actionTypeName: "assign",
                expression: {
                    kind: "inputReference",
                    value: {
                        name: "user",
                    },
                },
                resolveParameter: () => Promise.resolve("user-1"),
                context: {},
                tx: { query } as never,
            })
        ).resolves.toBe("user-1");
    });

    it("executes to-one related expressions and explicitly rejects unsupported to-many execution", async () => {
        const projectType = {
            name: "Project",
            displayName: "Project",
            pluralDisplayName: "Projects",
            primaryKey: "id",
            properties: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
                {
                    name: "ownerId",
                    displayName: "Owner",
                    type: o.string({}),
                },
            ],
        };
        const linkIr: OntologyIR = {
            ...ir,
            objectTypes: [...ir.objectTypes, projectType],
            linkTypes: [
                {
                    id: "projectOwner",
                    source: {
                        objectType: "Project",
                        name: "projects",
                        displayName: "Projects",
                    },
                    target: {
                        objectType: "User",
                        name: "owner",
                        displayName: "Owner",
                    },
                    foreignKey: "ownerId",
                    cardinality: "many",
                },
            ],
            actionTypes: [
                {
                    ...ir.actionTypes[0]!,
                    parameters: [
                        ...ir.actionTypes[0]!.parameters,
                        {
                            name: "project",
                            displayName: "Project",
                            type: o.objectReference({
                                objectType: "Project",
                            }),
                        },
                    ],
                },
            ],
        };
        const users = createCollection(
            localOnlyCollectionOptions<OntologyObject, string | number>({
                id: "related-users",
                getKey: (user) => user.id as string | number,
                initialData: [
                    {
                        id: "user-1",
                        name: "Ada",
                    },
                ],
            })
        );
        const projects = createCollection(
            localOnlyCollectionOptions<OntologyObject, string | number>({
                id: "related-projects",
                getKey: (project) => project.id as string | number,
                initialData: [
                    {
                        id: "project-1",
                        ownerId: "user-1",
                    },
                ],
            })
        );
        await Promise.all([
            queryOnce((q) => q.from({ row: users })),
            queryOnce((q) => q.from({ row: projects })),
        ]);

        await expect(
            evaluateExpression({
                ir: linkIr,
                actionTypeName: "assign",
                expression: o.Expression.getAt({
                    source: o.Expression.related({
                        source: o.Expression.lookup({
                            reference: o.Expression.inputReference({
                                name: "project",
                            }),
                        }),
                        link: "owner",
                    }),
                    path: ["name"],
                }),
                resolveParameter: () => Promise.resolve("project-1"),
                context: {},
                tx: createReadTx({
                    User: users,
                    Project: projects,
                }),
            })
        ).resolves.toBe("Ada");

        await expect(
            evaluateExpression({
                ir: linkIr,
                actionTypeName: "assign",
                expression: o.Expression.related({
                    source: o.Expression.lookup({
                        reference: o.Expression.inputReference({ name: "user" }),
                    }),
                    link: "projects",
                }),
                resolveParameter: () => Promise.resolve("user-1"),
                context: {},
                tx: createReadTx({ User: users, Project: projects }),
            })
        ).rejects.toThrow("not supported in action execution yet");

        await Promise.all([users.cleanup(), projects.cleanup()]);
    });

    it("maps list elements into constructed structs", async () => {
        await expect(
            evaluateExpression({
                ir,
                actionTypeName: "assign",
                expression: o.Expression.map({
                    source: o.Expression.inputReference({
                        name: "entries",
                    }),
                    binding: "entry",
                    body: o.Expression.struct({
                        fields: [
                            {
                                name: "renamedCode",
                                value: o.Expression.getAt({
                                    source: o.Expression.localReference({
                                        name: "entry",
                                    }),
                                    path: ["code"],
                                }),
                            },
                            {
                                name: "actor",
                                value: o.Expression.contextReference({
                                    name: "user",
                                }),
                            },
                        ],
                    }),
                }),
                resolveParameter: (name) =>
                    Promise.resolve(name === "entries" ? [{ code: "alpha" }, { code: "beta" }] : undefined),
                context: { user: "user-1" },
                tx: createReadTx({}),
            })
        ).resolves.toEqual([
            {
                renamedCode: "alpha",
                actor: "user-1",
            },
            {
                renamedCode: "beta",
                actor: "user-1",
            },
        ]);
    });

    it("preserves an undefined optional map source", async () => {
        await expect(
            evaluateExpression({
                ir,
                actionTypeName: "assign",
                expression: o.Expression.map({
                    source: o.Expression.inputReference({
                        name: "entries",
                    }),
                    binding: "entry",
                    body: o.Expression.localReference({
                        name: "entry",
                    }),
                }),
                resolveParameter: () => Promise.resolve(undefined),
                context: {},
                tx: createReadTx({}),
            })
        ).resolves.toBeUndefined();
    });
});

it("replay fixes nested body UUIDs and time while keeping map items and expression locations distinct", async () => {
    const expression = o.Expression.map({
        source: o.Expression.literal({ type: o.list({ elementType: o.string({}) }), value: ["a", "b"] }),
        binding: "item",
        body: o.Expression.struct({
            fields: [
                { name: "id", value: o.Expression.uuid({}) },
                { name: "otherId", value: o.Expression.uuid({}) },
                { name: "time", value: o.Expression.now({}) },
            ],
        }),
    });
    const options = {
        ir,
        actionTypeName: "assign",
        expression,
        context: {},
        tx: createReadTx({}),
        resolveParameter: async () => undefined,
        replay: { now: "2026-10-21T00:00:00Z", seed: "action-one" },
        location: ["logic", 0],
    };
    const first = (await evaluateExpression(options)) as {
        id: string;
        otherId: string;
        time: { toString(): string };
    }[];
    const second = await evaluateExpression(options);
    expect(second).toEqual(first);
    expect(new Set(first.flatMap((row) => [row.id, row.otherId])).size).toBe(4);
    expect(first.map((row) => row.time.toString())).toEqual(["2026-10-21T00:00:00Z", "2026-10-21T00:00:00Z"]);
    expect(
        await evaluateExpression({ ...options, replay: { ...options.replay, seed: "action-two" } })
    ).not.toEqual(first);
});
