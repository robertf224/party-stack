import { field, eq, and, indexesForQuery, type Query } from "@party-stack/ontology-storage";
import { createAdapterFactory, type AdapterFactory, type CustomAdapter } from "better-auth/adapters";
import { Effect, Fiber, Schema, Scope } from "effect";
import { authStorageSchema, encodeAuthValue, decodeAuthRow, type AuthRow } from "./model.js";
import { authQuery } from "./query.js";
import { compileAuthViews, type AuthModelView, type AuthObject, type AuthTransaction } from "./view.js";
import type {
    OwnedReadTransaction,
    OwnedStorageTransaction,
    OwnedStorageService,
} from "@party-stack/ontology-backend/owned";
import type { BetterAuthOptions } from "better-auth";

export type { AuthModelView } from "./view.js";
export class AuthStorageError extends Schema.TaggedError<AuthStorageError>()("AuthStorageError", {
    operation: Schema.String,
    message: Schema.String,
}) {}
const failure = (operation: string) =>
    new AuthStorageError({ operation, message: `Authentication storage ${operation} failed.` });
const protect = <A, E, R>(operation: string, work: Effect.Effect<A, E, R>) =>
    work.pipe(Effect.mapError((cause) => (cause instanceof AuthStorageError ? cause : failure(operation))));
type Run = <A, E>(work: Effect.Effect<A, E>) => Promise<A>;
type Selection = Parameters<CustomAdapter["findMany"]>[0];
type Where = Parameters<CustomAdapter["findOne"]>[0]["where"];

/** A standard Better Auth database factory backed by native ontology storage.
 * Better Auth owns password hashing, cookies and authorization; this owns persistence.
 */
export const makeBetterAuthStorage = Effect.fn("BetterAuth.storage")(function* (options: {
    /** Trusted, journaled storage capability from makeOwnedBackend. */
    readonly storage: OwnedStorageService;
    /** Keys are Better Auth logical model names, including plugin models. */
    readonly models: Readonly<Record<string, AuthModelView>>;
}): Effect.fn.Return<AdapterFactory<BetterAuthOptions>, never, Scope.Scope> {
    const owner = yield* Effect.scope;
    const context = yield* Effect.context<never>();
    let closed = false;
    yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
            closed = true;
        })
    );
    const owned: Run = <A, E>(work: Effect.Effect<A, E>) =>
        Effect.runPromiseWith(context)(
            Effect.suspend<A, E | AuthStorageError, never>(() =>
                closed
                    ? Effect.fail(failure("closed"))
                    : Effect.flatMap(Effect.forkIn(work, owner), Fiber.join)
            )
        );
    return (authOptions) => {
        const { schema, logical } = authStorageSchema(authOptions);
        const views = compileAuthViews(options.storage.ir, options.models, logical);
        const storage = options.storage;
        const object = views.object;
        const view = (tx: OwnedStorageTransaction | OwnedReadTransaction) => views.bind(tx);
        const build = (
            run: Run,
            bound?: OwnedStorageTransaction,
            usable: () => boolean = () => true
        ): AdapterFactory<BetterAuthOptions> =>
            createAdapterFactory({
                config: {
                    adapterId: "party-stack-ontology",
                    adapterName: "Party Stack ontology storage",
                    supportsNumericIds: false,
                    supportsUUIDs: false,
                    supportsDates: true,
                    supportsBooleans: true,
                    supportsJSON: true,
                    supportsArrays: true,
                    transaction: (callback) =>
                        run(
                            Effect.gen(function* () {
                                if (!usable() || bound) return yield* failure("transaction");
                                return yield* storage.transaction((tx) =>
                                    Effect.gen(function* () {
                                        const context = yield* Effect.context<never>();
                                        let active = true;
                                        const transactionRun: Run = (effect) =>
                                            run(Effect.provideContext(effect, context));
                                        return yield* Effect.tryPromise({
                                            try: () =>
                                                callback(
                                                    build(transactionRun, tx, () => active)(authOptions)
                                                ),
                                            catch: (cause) => cause,
                                        }).pipe(
                                            Effect.ensuring(
                                                Effect.sync(() => {
                                                    active = false;
                                                })
                                            )
                                        );
                                    })
                                );
                            })
                        ),
                },
                adapter: ({ getFieldName }) => {
                    const use = <A>(
                        operation: string,
                        write: boolean,
                        body: (
                            tx: AuthTransaction,
                            object: (name: string) => AuthObject
                        ) => Effect.Effect<A, unknown>
                    ) =>
                        run(
                            protect(
                                operation,
                                Effect.gen(function* () {
                                    if (!usable()) return yield* failure("expired transaction");
                                    if (bound) {
                                        return yield* body(view(bound), object);
                                    }
                                    return yield* write
                                        ? storage.transaction((tx) => body(view(tx), object))
                                        : storage.read((tx) => body(view(tx), object));
                                })
                            )
                        );
                    const prepare = Effect.fnUntraced(function* (
                        tx: AuthTransaction,
                        object: AuthObject,
                        query?: Query
                    ) {
                        for (const [name, attribute] of Object.entries(schema[object.name]!.fields)) {
                            if (
                                attribute.unique ||
                                attribute.index ||
                                attribute.references ||
                                attribute.type === "date"
                            )
                                yield* tx.ensureIndex(object, {
                                    name: `auth:${name}`,
                                    field: field(name),
                                    unique: attribute.unique,
                                });
                        }
                        for (const index of schema[object.name]!.indexes ?? [])
                            for (const name of index.columns)
                                yield* tx.ensureIndex(object, {
                                    name: `auth:index:${name}`,
                                    field: field(name),
                                });
                        for (const index of indexesForQuery(
                            query ?? {},
                            new Set(object.definition.properties.map((field) => field.name))
                        ))
                            yield* tx.ensureIndex(object, index);
                    });
                    const selectRows = Effect.fnUntraced(function* (
                        tx: AuthTransaction,
                        object: AuthObject,
                        selection: Partial<Omit<Selection, "model" | "join" | "select">> = {}
                    ) {
                        const translated = yield* Effect.try({
                            try: () => authQuery(schema, object.name, selection.where),
                            catch: () => failure("predicate"),
                        });
                        const query: Query = {
                            where: translated.where,
                            orderBy: selection.sortBy
                                ? [
                                      {
                                          field: field(
                                              getFieldName({
                                                  model: object.name,
                                                  field: selection.sortBy.field,
                                              })
                                          ),
                                          direction: selection.sortBy.direction,
                                      },
                                  ]
                                : undefined,
                            limit: translated.residual ? undefined : selection.limit,
                            offset: translated.residual ? undefined : selection.offset,
                        };
                        let rows = (yield* tx.loadSubset(object, query)).map((row) => row.value);
                        if (translated.residual)
                            rows = rows
                                .filter(translated.matches)
                                .slice(
                                    selection.offset ?? 0,
                                    selection.limit === undefined
                                        ? undefined
                                        : (selection.offset ?? 0) + selection.limit
                                );
                        return rows;
                    });
                    const encode = (model: string, input: Record<string, unknown>) =>
                        Effect.try({
                            try: () => {
                                const table = schema[model];
                                if (!table) throw failure("model");
                                return Object.fromEntries(
                                    Object.entries(input).map(([name, value]) => {
                                        if (name !== "id" && !Object.hasOwn(table.fields, name))
                                            throw failure("field");
                                        return [name, encodeAuthValue(table.fields[name], value)];
                                    })
                                );
                            },
                            catch: () => failure("value"),
                        });
                    const validate = Effect.fnUntraced(function* (
                        tx: AuthTransaction,
                        object: (name: string) => AuthObject,
                        model: string,
                        row: AuthRow
                    ) {
                        for (const [name, attribute] of Object.entries(schema[model]!.fields)) {
                            const reference = attribute.references;
                            if (reference && row[name] != null) {
                                const parent = yield* tx.loadSubset(object(reference.model), {
                                    where: eq(field(reference.field), row[name] as string),
                                    limit: 1,
                                });
                                if (!parent.length) return yield* failure("reference");
                            }
                        }
                        for (const index of schema[model]!.indexes ?? [])
                            if (index.unique) {
                                if (index.columns.some((name) => row[name] == null)) continue;
                                const existing = yield* tx.loadSubset(object(model), {
                                    limit: 2,
                                    where: and(
                                        ...index.columns.map((name) => eq(field(name), row[name] as string))
                                    ),
                                });
                                if (existing.some((other) => other.key !== row.id))
                                    return yield* failure("unique constraint");
                            }
                    });
                    const save = Effect.fnUntraced(function* (
                        tx: AuthTransaction,
                        object: (name: string) => AuthObject,
                        model: string,
                        row: AuthRow
                    ) {
                        yield* prepare(tx, object(model));
                        yield* validate(tx, object, model, row);
                        yield* tx.put(object(model), row);
                    });
                    const remove = Effect.fnUntraced(function* (
                        tx: AuthTransaction,
                        object: (name: string) => AuthObject,
                        model: string,
                        row: AuthRow,
                        visited = new Set<string>()
                    ): Effect.fn.Return<void, unknown> {
                        const key = JSON.stringify([model, row.id]);
                        if (visited.has(key)) return;
                        visited.add(key);
                        for (const [childModel, table] of Object.entries(schema))
                            for (const [name, attribute] of Object.entries(table.fields)) {
                                const ref = attribute.references;
                                if (!ref || ref.model !== model || row[ref.field] == null) continue;
                                const children = yield* tx.loadSubset(object(childModel), {
                                    where: eq(field(name), row[ref.field] as string),
                                });
                                for (const child of children) {
                                    switch (ref.onDelete ?? "cascade") {
                                        case "cascade":
                                            yield* remove(tx, object, childModel, child.value, visited);
                                            break;
                                        case "set null":
                                            yield* save(tx, object, childModel, {
                                                ...child.value,
                                                [name]: undefined,
                                            });
                                            break;
                                        case "set default": {
                                            const fallback = attribute.defaultValue;
                                            const value =
                                                typeof fallback === "function" ? fallback() : fallback;
                                            yield* save(tx, object, childModel, {
                                                ...child.value,
                                                [name]: encodeAuthValue(attribute, value),
                                            });
                                            break;
                                        }
                                        default:
                                            return yield* failure("reference constraint");
                                    }
                                }
                            }
                        yield* tx.delete(object(model), row.id);
                    });
                    const project = (model: string, row: AuthRow, select?: string[]) => {
                        const decoded = decodeAuthRow(schema, model, row);
                        return select
                            ? Object.fromEntries(
                                  select.map((name) => {
                                      const key = getFieldName({ model, field: name });
                                      return [key, decoded[key]];
                                  })
                              )
                            : decoded;
                    };
                    const find = (selection: Selection) =>
                        use("read", false, (tx, object) =>
                            Effect.gen(function* () {
                                const rows = yield* selectRows(tx, object(selection.model), selection);
                                return yield* Effect.forEach(rows, (row) =>
                                    Effect.gen(function* () {
                                        const result = project(selection.model, row, selection.select);
                                        for (const [model, join] of Object.entries(selection.join ?? {})) {
                                            const related =
                                                row[join.on.from] == null
                                                    ? []
                                                    : yield* tx.loadSubset(object(model), {
                                                          where: eq(
                                                              field(join.on.to),
                                                              row[join.on.from] as string
                                                          ),
                                                          limit: join.limit,
                                                      });
                                            const values = related.map((entry) =>
                                                decodeAuthRow(schema, model, entry.value)
                                            );
                                            result[model] =
                                                join.relation === "one-to-one" ? (values[0] ?? null) : values;
                                        }
                                        return result;
                                    })
                                );
                            })
                        );
                    const change = (
                        model: string,
                        where: Where,
                        update: Record<string, unknown>,
                        many: boolean
                    ) =>
                        use("update", true, (tx, object) =>
                            Effect.gen(function* () {
                                const rows = yield* selectRows(tx, object(model), {
                                    where,
                                    limit: many ? undefined : 1,
                                });
                                const patch = Object.fromEntries(
                                    Object.entries(update).filter(([, value]) => value !== undefined)
                                );
                                const encoded = yield* encode(model, patch);
                                for (const row of rows) {
                                    if (encoded.id !== undefined && encoded.id !== row.id)
                                        return yield* failure("primary key mutation");
                                    Object.assign(row, encoded);
                                    yield* save(tx, object, model, row);
                                }
                                return many
                                    ? rows.length
                                    : rows[0]
                                      ? decodeAuthRow(schema, model, rows[0])
                                      : null;
                            })
                        );
                    return {
                        create: <T extends Record<string, unknown>>({
                            model,
                            data,
                            select,
                        }: Parameters<CustomAdapter["create"]>[0] & { data: T }) =>
                            use("create", true, (tx, object) =>
                                Effect.gen(function* () {
                                    const row = yield* encode(model, data) as Effect.Effect<
                                        AuthRow,
                                        AuthStorageError
                                    >;
                                    if (typeof row.id !== "string" || (yield* tx.get(object(model), row.id)))
                                        return yield* failure("duplicate id");
                                    yield* save(tx, object, model, row);
                                    return project(model, row, select);
                                })
                            ) as Promise<T>,
                        findOne: <T>({
                            model,
                            where,
                            select,
                            join,
                        }: Parameters<CustomAdapter["findOne"]>[0]) =>
                            find({ model, where, select, join, limit: 1 }).then(
                                (rows) => rows[0] ?? null
                            ) as Promise<T | null>,
                        findMany: <T>(selection: Selection) => find(selection) as Promise<T[]>,
                        count: ({ model, where }) =>
                            use("count", false, (tx, object) =>
                                Effect.map(selectRows(tx, object(model), { where }), (rows) => rows.length)
                            ),
                        update: <T>({ model, where, update }: Parameters<CustomAdapter["update"]>[0]) =>
                            change(
                                model,
                                where,
                                update as Record<string, unknown>,
                                false
                            ) as Promise<T | null>,
                        updateMany: ({ model, where, update }) =>
                            change(model, where, update, true) as Promise<number>,
                        delete: ({ model, where }) =>
                            use("delete", true, (tx, object) =>
                                Effect.gen(function* () {
                                    const [row] = yield* selectRows(tx, object(model), { where, limit: 1 });
                                    if (row) yield* remove(tx, object, model, row);
                                })
                            ),
                        deleteMany: ({ model, where }) =>
                            use("deleteMany", true, (tx, object) =>
                                Effect.gen(function* () {
                                    const rows = yield* selectRows(tx, object(model), { where });
                                    for (const row of rows) yield* remove(tx, object, model, row);
                                    return rows.length;
                                })
                            ),
                        consumeOne: <T>({ model, where }: Parameters<CustomAdapter["consumeOne"]>[0]) =>
                            use("consumeOne", true, (tx, object) =>
                                Effect.gen(function* () {
                                    const [row] = yield* selectRows(tx, object(model), { where, limit: 1 });
                                    if (!row) return null;
                                    yield* remove(tx, object, model, row);
                                    return decodeAuthRow(schema, model, row);
                                })
                            ) as Promise<T | null>,
                        incrementOne: <T>({
                            model,
                            where,
                            increment,
                            set,
                        }: Parameters<CustomAdapter["incrementOne"]>[0]) =>
                            use("incrementOne", true, (tx, object) =>
                                Effect.gen(function* () {
                                    const [row] = yield* selectRows(tx, object(model), { where, limit: 1 });
                                    if (!row) return null;
                                    const encoded = yield* encode(
                                        model,
                                        Object.fromEntries(
                                            Object.entries(set ?? {}).filter(
                                                ([, value]) => value !== undefined
                                            )
                                        )
                                    );
                                    if (encoded.id !== undefined && encoded.id !== row.id)
                                        return yield* failure("primary key mutation");
                                    if (Object.keys(increment).some((name) => Object.hasOwn(encoded, name)))
                                        return yield* failure("overlapping counter update");
                                    Object.assign(row, encoded);
                                    for (const [name, delta] of Object.entries(increment)) {
                                        if (
                                            schema[model]?.fields[name]?.type !== "number" ||
                                            !Number.isFinite(delta) ||
                                            (row[name] != null && typeof row[name] !== "number")
                                        )
                                            return yield* failure("counter");
                                        row[name] = ((row[name] as number | undefined) ?? 0) + delta;
                                    }
                                    yield* save(tx, object, model, row);
                                    return decodeAuthRow(schema, model, row);
                                })
                            ) as Promise<T | null>,
                    } satisfies CustomAdapter;
                },
            });
        return build(owned)(authOptions);
    };
});
