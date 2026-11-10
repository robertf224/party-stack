import { it } from "@effect/vitest";
import { o, validate } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { evaluateQuery } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Arbitrary, Effect, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { actionExpressions, executeAction } from "./actions.js";
import { makeOwnedBackend } from "./owned.js";
import { executeQuery } from "./query.js";
import { objectSubset } from "./subset.js";
import type { OwnedTransaction } from "./owned.js";
import type { Expression, OntologyIR, TypeDef } from "@party-stack/ontology-spec";

const p = (name: string, type: TypeDef) => ({ name, displayName: name, type });
const inputs = [p("n", o.double({})), p("text", o.string({})), p("flag", o.boolean({}))];
const definition = (): OntologyIR => ({
    types: [],
    objectTypes: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [{ name: "test", displayName: "Test", logic: [], parameters: [...inputs] }],
});
const noIO: OwnedTransaction = {
    get: () => Effect.die("Unexpected lookup"),
    loadSubset: () => Effect.die("Unexpected scan"),
    put: () => Effect.die("Unexpected write"),
    patch: () => Effect.die("Unexpected patch"),
    delete: () => Effect.die("Unexpected deletion"),
};
const evaluate = (expression: Expression, ir = definition()) =>
    actionExpressions({
        ir,
        tx: noIO,
        request: { id: "test", name: "test", parameters: { n: 3, text: "Alpha", flag: true } },
    }).evaluate(expression);

test.each([
    [q.add(q.input("n"), q.literal(2)), 5],
    [q.subtract(q.input("n"), q.literal(2)), 1],
    [q.multiply(q.input("n"), q.literal(2)), 6],
    [q.divide(q.input("n"), q.literal(2)), 1.5],
    [q.eq(q.literal([1, { x: "y" }]), q.literal([1, { x: "y" }])), true],
    [q.ne(q.literal(null), q.literal(undefined)), true],
    [q.lt(q.input("n"), q.literal(4)), true],
    [q.lte(q.input("n"), q.literal(3)), true],
    [q.gt(q.input("n"), q.literal(2)), true],
    [q.gte(q.input("n"), q.literal(4)), false],
    [q.lt(q.literal(false), q.input("flag")), true],
    [q.lte(q.input("flag"), q.literal(false)), false],
    [q.gt(q.input("flag"), q.literal(false)), true],
    [q.gte(q.input("flag"), q.literal(true)), true],
    [q.inArray(q.input("n"), q.literal([2, 3])), true],
    [q.contains(q.literal(["Alpha", "Beta"]), q.input("text")), true],
    [q.like(q.input("text"), q.literal("A_ph%")), true],
    [q.ilike(q.input("text"), q.literal("a%")), true],
    [q.concat(q.input("text"), q.literal("!")), "Alpha!"],
    [q.not(q.input("flag")), false],
    [q.coalesce(q.literal(undefined), q.literal(null), q.input("text")), "Alpha"],
    [q.coalesce(q.literal(undefined), q.literal(null)), undefined],
] as const)("actions execute shared scalar operator %#", async (expression, expected) => {
    expect(await Effect.runPromise(evaluate(expression))).toEqual(expected);
});

test("boolean/CASE/coalesce short circuit without evaluating failing branches", async () => {
    const invalid = q.divide(q.literal(1), q.literal(0));
    for (const [expression, expected] of [
        [q.and(q.literal(false), q.eq(invalid, q.literal(0))), false],
        [q.or(q.literal(true), q.eq(invalid, q.literal(0))), true],
        [
            q.caseExpression({
                branches: [
                    { condition: q.literal(false), result: invalid },
                    { condition: q.literal(true), result: q.literal(7) },
                ],
                else: invalid,
            }),
            7,
        ],
        [q.coalesce(q.literal(7), invalid), 7],
    ] as const)
        expect(await Effect.runPromise(evaluate(expression))).toBe(expected);
    expect(await Effect.runPromise(Effect.result(evaluate(invalid)))).toMatchObject({
        _tag: "Failure",
        failure: { kind: "InvalidRequest", message: "Arithmetic produced a nonfinite result." },
    });
});

test("partial defaults stay unresolved until required inputs are known, while selected branches resolve", async () => {
    const ir = definition();
    ir.actionTypes[0]!.parameters.push(
        {
            ...p("total", o.optional({ type: o.double({}) })),
            defaultValue: q.add(q.input("n"), q.literal(1)),
        },
        { ...p("fallbackTotal", o.double({})), defaultValue: q.coalesce(q.input("total"), q.literal(0)) },
        {
            ...p("summary", o.string({})),
            defaultValue: q.caseExpression({
                branches: [{ condition: q.input("flag"), result: q.input("text") }],
                else: q.literal("Disabled"),
            }),
        }
    );
    const resolve = (parameters: Record<string, unknown>) =>
        Effect.runPromise(
            actionExpressions({ ir, tx: noIO, request: { id: "partial", name: "test", parameters } }).resolve
        );
    expect(await resolve({})).toEqual({});
    expect(await resolve({ flag: false })).toEqual({ flag: false, summary: "Disabled" });
    expect(await resolve({ n: 3, flag: true, text: "Ready" })).toMatchObject({
        total: 4,
        fallbackTotal: 4,
        summary: "Ready",
    });
    const invalid = actionExpressions({
        ir,
        tx: noIO,
        request: { id: "invalid", name: "test", parameters: { n: "bad" } },
    }).resolve;
    expect(await Effect.runPromise(Effect.result(invalid))).toMatchObject({
        _tag: "Failure",
        failure: { kind: "InvalidRequest" },
    });
});

type Env = { n: number; flag: boolean; text: string };
type Numeric = { expression: Expression; run: (env: Env) => number };
const numeric = (depth: number): Arbitrary.Arbitrary<Numeric> =>
    Arbitrary.flatMap(
        Arbitrary.schema(
            depth <= 0
                ? Schema.Literals(["literal", "input"])
                : Schema.Literals(["literal", "input", "add", "subtract", "multiply", "case"])
        ),
        (kind): Arbitrary.Arbitrary<Numeric> => {
            if (kind === "literal")
                return Arbitrary.map(
                    Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: -9, maximum: 9 }))),
                    (n): Numeric => ({ expression: q.literal(n), run: () => n })
                );
            if (kind === "input")
                return Arbitrary.Constant<Numeric>({ expression: q.input("n"), run: (env) => env.n });
            return Arbitrary.map(
                Arbitrary.all([numeric(depth - 1), numeric(depth - 1)]),
                ([a, b]): Numeric =>
                    kind === "case"
                        ? {
                              expression: q.caseExpression({
                                  branches: [{ condition: q.input("flag"), result: a.expression }],
                                  else: b.expression,
                              }),
                              run: (env) => (env.flag ? a.run(env) : b.run(env)),
                          }
                        : {
                              expression: q[kind](a.expression, b.expression),
                              run: (env) =>
                                  kind === "add"
                                      ? a.run(env) + b.run(env)
                                      : kind === "subtract"
                                        ? a.run(env) - b.run(env)
                                        : a.run(env) * b.run(env),
                          }
            );
        }
    );

it.live.prop(
    "generated action defaults and finite queries agree with an independent expression oracle",
    [
        numeric(3),
        Schema.Struct({
            n: Schema.Int.check(Schema.isBetween({ minimum: -10, maximum: 10 })),
            flag: Schema.Boolean,
            text: Schema.String.check(Schema.isMaxLength(8)),
        }),
    ],
    ([tree, env]) =>
        Effect.gen(function* () {
            const ir = definition();
            ir.actionTypes[0]!.parameters.push({
                ...p("result", o.double({})),
                defaultValue: tree.expression,
            });
            expect(validate(ir).kind).toBe("ok");
            const expected = tree.run(env);
            const action = actionExpressions({
                ir,
                tx: noIO,
                request: { id: "oracle", name: "test", parameters: env },
            });
            expect((yield* action.resolve).result).toBe(expected);
            for (const strategy of ["planned", "reference"] as const) {
                const result = yield* executeQuery(
                    { inputs, select: [q.selectField("result", tree.expression)] },
                    {
                        reader: { ir, loadSubset: (type, scan) => noIO.loadSubset(type, scan) },
                        inputs: env,
                        strategy,
                    }
                );
                expect(result.value.result).toBe(expected);
            }
        }),
    { arbitrary: { runs: 150 } }
);

test("computed defaults, map bindings and replay UUIDs compose in portable action writes", async () => {
    const ir = definition();
    const uuid = o.Expression.uuid({});
    const id = q.caseExpression({
        branches: [{ condition: q.input("flag"), result: uuid }],
        else: q.literal("disabled"),
    });
    ir.objectTypes = [
        {
            name: "Result",
            displayName: "Result",
            pluralDisplayName: "Results",
            primaryKey: "id",
            properties: [
                p("id", o.string({})),
                p("title", o.string({})),
                p("values", o.list({ elementType: o.double({}) })),
                p("otherId", o.string({})),
            ],
        },
    ];
    ir.actionTypes[0]!.parameters.push(
        { ...p("id", o.string({})), defaultValue: id },
        { ...p("title", o.string({})), defaultValue: q.concat(q.input("text"), q.literal("!")) }
    );
    ir.actionTypes[0]!.logic = [
        o.ActionLogicStep.createObject({
            objectType: "Result",
            values: [
                { property: ["id"], value: q.input("id") },
                { property: ["title"], value: q.input("title") },
                { property: ["otherId"], value: uuid },
                {
                    property: ["values"],
                    value: o.Expression.map({
                        source: q.literal([1, 2, 3]),
                        binding: "item",
                        body: q.add(q.row("item"), q.input("n")),
                    }),
                },
            ],
        }),
    ];
    expect(validate(ir).kind).toBe("ok");
    const writes: Record<string, unknown>[] = [];
    const request = {
        id: "replay",
        name: "test",
        parameters: { n: 3, flag: true, text: "Hello" },
        replay: { seed: "stable", now: "2026-11-03T00:00:00Z" },
    };
    for (let i = 0; i < 2; i++)
        await Effect.runPromise(
            executeAction({
                ir,
                request,
                tx: {
                    ...noIO,
                    get: () => Effect.succeed(undefined),
                    put: (_type, value) =>
                        Effect.sync(() => {
                            writes.push(value);
                        }),
                },
            })
        );
    expect(writes[0]).toEqual(writes[1]);
    expect(writes[0]).toMatchObject({ title: "Hello!", values: [4, 5, 6] });
    expect(writes[0]!.id).not.toBe(writes[0]!.otherId);
});

test("input/context reference paths use the same lookup target in actions and queries", async () => {
    const ir = definition();
    ir.objectTypes = [
        {
            name: "Project",
            displayName: "Project",
            pluralDisplayName: "Projects",
            primaryKey: "id",
            properties: [p("id", o.string({})), p("title", o.string({}))],
        },
    ];
    ir.types = [
        {
            name: "Selection",
            type: o.struct({
                fields: [p("project", o.optional({ type: o.objectReference({ objectType: "Project" }) }))],
            }),
        },
    ];
    ir.actionTypes[0]!.parameters.push(p("selection", o.ref({ name: "Selection" })));
    ir.context = {
        type: o.struct({ fields: [p("selection", o.optional({ type: o.ref({ name: "Selection" }) }))] }),
    };
    const row = { id: "p1", title: "Project 1" };
    let gets = 0;
    const tx: OwnedTransaction = {
        ...noIO,
        get: (type, key) =>
            Effect.sync(() => {
                gets++;
                expect([type, key]).toEqual(["Project", "p1"]);
                return row;
            }),
        loadSubset: (_type, scan) => Effect.succeed(evaluateQuery([{ key: "p1", value: row }], scan)),
    };
    const values = { n: 1, text: "", flag: true, selection: { project: "p1" } };
    for (const reference of [
        q.context("selection", "project"),
        o.Expression.getAt({ source: q.input("selection"), path: ["project"] }),
    ]) {
        const expression = o.Expression.getAt({ source: q.lookup(reference), path: ["title"] });
        const context = { selection: { project: "p1" } };
        const action = actionExpressions({
            ir,
            tx,
            context,
            request: { id: "lookup", name: "test", parameters: values },
        });
        expect(await Effect.runPromise(action.evaluate(expression))).toBe("Project 1");
        expect(
            (
                await Effect.runPromise(
                    executeQuery(
                        {
                            inputs: ir.actionTypes[0]!.parameters,
                            select: [q.selectField("value", expression)],
                        },
                        {
                            reader: { ir, loadSubset: (type, scan) => tx.loadSubset(type, scan) },
                            inputs: values,
                            context,
                        }
                    )
                )
            ).value
        ).toEqual({ value: "Project 1" });
    }
    expect(gets).toBe(2);
    expect(
        await Effect.runPromise(
            actionExpressions({
                ir,
                tx,
                context: {},
                request: { id: "empty", name: "test", parameters: values },
            }).evaluate(q.lookup(q.context("selection", "project")))
        )
    ).toBeUndefined();
    expect(gets).toBe(2);
});

test("unsupported row-field lookups fail validation before source IO", async () => {
    const ir = definition();
    ir.objectTypes = [
        {
            name: "Project",
            displayName: "Project",
            pluralDisplayName: "Projects",
            primaryKey: "id",
            properties: [p("id", o.string({})), p("parent", o.objectReference({ objectType: "Project" }))],
        },
    ];
    const query = {
        select: [
            q.sub("projects", {
                from: { source: { objectType: "Project" }, binding: "p" },
                select: [q.selectField("parent", q.lookup(q.field("p", "parent")))],
            }),
        ],
    };
    expect(
        await Effect.runPromise(
            Effect.result(
                executeQuery(query, {
                    reader: { ir, loadSubset: (type, scan) => noIO.loadSubset(type, scan) },
                })
            )
        )
    ).toMatchObject({
        _tag: "Failure",
        failure: {
            kind: "InvalidRequest",
            issues: expect.arrayContaining([
                expect.objectContaining({ message: expect.stringContaining("use related") }),
            ]),
        },
    });
});

test("COALESCE preserves loaded entity identity for subsequent relationship traversal", async () => {
    const ir = definition();
    const reference = o.objectReference({ objectType: "Project" });
    ir.actionTypes[0]!.parameters.push(
        p("preferred", o.optional({ type: reference })),
        p("fallback", reference)
    );
    ir.objectTypes = [
        {
            name: "Project",
            displayName: "Project",
            pluralDisplayName: "Projects",
            primaryKey: "id",
            properties: [
                p("id", o.string({})),
                p("title", o.string({})),
                p("parentId", o.optional({ type: o.string({}) })),
            ],
        },
    ];
    ir.linkTypes = [
        {
            id: "parent",
            source: { objectType: "Project", name: "children", displayName: "Children" },
            target: { objectType: "Project", name: "parent", displayName: "Parent" },
            foreignKey: "parentId",
            cardinality: "many",
        },
    ];
    const expression = o.Expression.getAt({
        source: o.Expression.related({
            source: q.coalesce(q.lookup(q.input("preferred")), q.lookup(q.input("fallback"))),
            link: "parent",
        }),
        path: ["title"],
    });
    ir.actionTypes[0]!.parameters.push({
        ...p("result", o.optional({ type: o.string({}) })),
        defaultValue: expression,
    });
    expect(validate(ir).kind).toBe("ok");
    const rows = [
        { id: "child", title: "Child", parentId: "parent" },
        { id: "parent", title: "Parent" },
    ];
    const tx: OwnedTransaction = {
        ...noIO,
        get: (_type, key) => Effect.succeed(rows.find((row) => row.id === key)),
        loadSubset: (_type, scan) =>
            Effect.succeed(
                evaluateQuery(
                    rows.map((value) => ({ key: value.id, value })),
                    scan
                )
            ),
    };
    const parameters = { n: 0, flag: false, text: "", fallback: "child" };
    expect(
        await Effect.runPromise(
            actionExpressions({ ir, tx, request: { id: "coalesce", name: "test", parameters } }).evaluate(
                expression
            )
        )
    ).toBe("Parent");
    expect(
        (
            await Effect.runPromise(
                executeQuery(
                    { inputs: ir.actionTypes[0]!.parameters, select: [q.selectField("title", expression)] },
                    {
                        reader: { ir, loadSubset: (type, scan) => tx.loadSubset(type, scan) },
                        inputs: parameters,
                    }
                )
            )
        ).value
    ).toEqual({ title: "Parent" });
});

test("scalar failures roll back earlier action writes; a valid branch commits normally", async () => {
    const ir = definition();
    ir.objectTypes = [
        {
            name: "Result",
            displayName: "Result",
            pluralDisplayName: "Results",
            primaryKey: "id",
            properties: [p("id", o.string({})), p("value", o.double({}))],
        },
    ];
    ir.actionTypes[0]!.logic = ["first", "second"].map((id) =>
        o.ActionLogicStep.createObject({
            objectType: "Result",
            values: [
                { property: ["id"], value: q.literal(id) },
                {
                    property: ["value"],
                    value:
                        id === "first"
                            ? q.input("n")
                            : q.caseExpression({
                                  branches: [
                                      {
                                          condition: q.input("flag"),
                                          result: q.divide(q.literal(1), q.literal(0)),
                                      },
                                  ],
                                  else: q.add(q.input("n"), q.literal(1)),
                              }),
                },
            ],
        })
    );
    expect(validate(ir).kind).toBe("ok");
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    ir,
                    tables: yield* Memory.make(),
                    namespace: "scalar-rollback",
                    mutators: {
                        test: (tx, request) => executeAction({ ir, tx, request }).pipe(Effect.asVoid),
                    },
                });
                expect(
                    yield* Effect.result(
                        backend.applyAction({
                            id: "invalid",
                            name: "test",
                            parameters: { n: 3, text: "", flag: true },
                        })
                    )
                ).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "InvalidRequest" },
                });
                expect((yield* backend.loadSubset(objectSubset("Result"))).rows).toEqual([]);
                expect((yield* backend.changes!.pull({})).commits).toEqual([]);
                expect(
                    (yield* backend.applyAction({
                        id: "valid",
                        name: "test",
                        parameters: { n: 3, text: "", flag: false },
                    })).outcome
                ).toBe("committed");
                expect((yield* backend.loadSubset(objectSubset("Result"))).rows.map((r) => r.value)).toEqual([
                    { id: "first", value: 3 },
                    { id: "second", value: 4 },
                ]);
            })
        )
    );
});
