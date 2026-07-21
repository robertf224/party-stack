import { IR, compileSingleRowExpression, parseWhereExpression } from "@tanstack/db";
import {
    encodePersistedStorageKey,
    type PersistedIndexSpec,
    type PersistedTx,
    type PersistenceAdapter,
} from "@tanstack/db-sqlite-persistence-core";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { Temporal } from "temporal-polyfill";
import type { LoadSubsetOptions } from "@tanstack/db";

type PersistedRow = Awaited<ReturnType<PersistenceAdapter["loadSubset"]>>[number];
type IndexValue = string | number | Date;
type IndexValueType =
    | "bigint"
    | "boolean"
    | "date"
    | "nan"
    | "null"
    | "number"
    | "temporal-instant"
    | "temporal-plain-date"
    | "string"
    | "string-ci"
    | "undefined";

const DATABASE_VERSION = 1;
const ROWS = "rows";
const TRANSACTIONS = "transactions";
const COLLECTION_METADATA = "collectionMetadata";
const STREAMS = "streams";
const INDEX_DEFINITIONS = "indexDefinitions";
const INDEX_ENTRIES = "indexEntries";
const BY_COLLECTION = "collectionId";
const BY_INDEX = "index";
const BY_LOOKUP = "lookup";

interface RowRecord extends PersistedRow {
    id: string;
    collectionId: string;
}

interface TransactionRecord {
    id: string;
    collectionId: string;
}

interface CollectionMetadataRecord {
    id: string;
    collectionId: string;
    key: string;
    value: unknown;
}

interface StreamRecord {
    collectionId: string;
    latestTerm: number;
    latestSeq: number;
    latestRowVersion: number;
}

interface IndexDefinitionRecord {
    collectionId: string;
    signature: string;
    expression: IR.BasicExpression;
    valueTypes: IndexValueType[];
    hasUnsupportedValues: boolean;
}

interface IndexEntryRecord {
    collectionId: string;
    signature: string;
    valueType: IndexValueType;
    rowId: string;
    value: IndexValue;
}

interface RuntimePersistenceDB extends DBSchema {
    rows: {
        key: string;
        value: RowRecord;
        indexes: { collectionId: string };
    };
    transactions: {
        key: string;
        value: TransactionRecord;
        indexes: { collectionId: string };
    };
    collectionMetadata: {
        key: string;
        value: CollectionMetadataRecord;
        indexes: { collectionId: string };
    };
    streams: {
        key: string;
        value: StreamRecord;
    };
    indexDefinitions: {
        key: [string, string];
        value: IndexDefinitionRecord;
        indexes: { collectionId: string };
    };
    indexEntries: {
        key: [string, string, IndexValueType, string];
        value: IndexEntryRecord;
        indexes: {
            collectionId: string;
            index: [string, string];
            lookup: [string, string, IndexValueType, IndexValue];
        };
    };
}

interface EncodedIndexValue {
    type: IndexValueType;
    value: IndexValue;
}

interface IndexPlan {
    kind: "and" | "lookup" | "none" | "or";
    children?: IndexPlan[];
    definition?: IndexDefinitionRecord;
    ranges?: IDBKeyRange[];
}

const PERSISTED_TYPE = "__party_stack_runtime_persisted_type__";

interface PersistedTemporalValue {
    [PERSISTED_TYPE]: "Temporal.Instant" | "Temporal.PlainDate";
    value: string;
}

export interface IndexedDBPersistenceAdapterOptions {
    databaseName: string;
    onBlocked?: () => void;
    onVersionChange?: (event: IDBVersionChangeEvent) => void;
}

function id(...parts: string[]): string {
    return JSON.stringify(parts);
}

function rowId(collectionId: string, key: string | number): string {
    return id(collectionId, encodePersistedStorageKey(key));
}

function temporalTag(value: unknown): string | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const tag = (value as { [Symbol.toStringTag]?: unknown })[
        Symbol.toStringTag
    ];
    return typeof tag === "string" ? tag : undefined;
}

function encodePersistedValue(value: unknown): unknown {
    const tag = temporalTag(value);
    if (tag === "Temporal.Instant" || tag === "Temporal.PlainDate") {
        return {
            [PERSISTED_TYPE]: tag,
            value: String(value),
        } satisfies PersistedTemporalValue;
    }
    if (Array.isArray(value)) {
        return value.map(encodePersistedValue);
    }
    if (typeof value === "object" && value !== null) {
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype === Object.prototype || prototype === null) {
            return Object.fromEntries(
                Object.entries(value).map(([key, entry]) => [
                    key,
                    encodePersistedValue(entry),
                ])
            );
        }
    }
    return value;
}

function decodePersistedValue(value: unknown): unknown {
    if (
        typeof value === "object" &&
        value !== null &&
        PERSISTED_TYPE in value &&
        "value" in value
    ) {
        const persisted = value as PersistedTemporalValue;
        if (persisted[PERSISTED_TYPE] === "Temporal.Instant") {
            return Temporal.Instant.from(persisted.value);
        }
        if (persisted[PERSISTED_TYPE] === "Temporal.PlainDate") {
            return Temporal.PlainDate.from(persisted.value);
        }
    }
    if (Array.isArray(value)) {
        return value.map(decodePersistedValue);
    }
    if (typeof value === "object" && value !== null) {
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype === Object.prototype || prototype === null) {
            return Object.fromEntries(
                Object.entries(value).map(([key, entry]) => [
                    key,
                    decodePersistedValue(entry),
                ])
            );
        }
    }
    return value;
}

function encodeIndexValue(value: unknown): EncodedIndexValue | undefined {
    const tag = temporalTag(value);
    if (tag === "Temporal.PlainDate") {
        return {
            type: "temporal-plain-date",
            value: String(value),
        };
    }
    if (tag === "Temporal.Instant") {
        return {
            type: "temporal-instant",
            value: Temporal.Instant.from(String(value)).epochMilliseconds,
        };
    }
    if (value === null) {
        return { type: "null", value: 0 };
    }
    if (value === undefined) {
        return { type: "undefined", value: 0 };
    }
    if (typeof value === "string") {
        return { type: "string", value };
    }
    if (typeof value === "number") {
        if (Number.isNaN(value)) {
            return { type: "nan", value: 0 };
        }
        return { type: "number", value };
    }
    if (typeof value === "bigint") {
        return { type: "bigint", value: value.toString() };
    }
    if (typeof value === "boolean") {
        return { type: "boolean", value: value ? 1 : 0 };
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime())
            ? { type: "nan", value: 0 }
            : { type: "date", value };
    }
    return undefined;
}

interface ExpressionOperand {
    kind: "expression";
    expression: IR.BasicExpression;
}

function pathsMatch(left: readonly string[], right: readonly string[]): boolean {
    const [longer, shorter] = left.length >= right.length ? [left, right] : [right, left];
    const offset = longer.length - shorter.length;
    return shorter.every((part, index) => longer[offset + index] === part);
}

function parseIndexExpression(spec: PersistedIndexSpec): IR.BasicExpression {
    const serialized = spec.expressionSql[0];
    if (!serialized) {
        throw new Error("Persisted index spec is missing its expression.");
    }
    return JSON.parse(serialized) as IR.BasicExpression;
}

function isExpressionOperand(value: unknown): value is ExpressionOperand {
    return (
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        value.kind === "expression"
    );
}

function toExpression(value: unknown): IR.BasicExpression {
    if (isExpressionOperand(value)) return value.expression;
    if (
        Array.isArray(value) &&
        value.every((part) => typeof part === "string")
    ) {
        return new IR.PropRef(value);
    }
    return new IR.Value(value);
}

function expressionsMatch(
    indexed: IR.BasicExpression,
    queried: IR.BasicExpression
): boolean {
    if (indexed.type !== queried.type) return false;
    if (indexed.type === "ref" && queried.type === "ref") {
        return pathsMatch(indexed.path, queried.path);
    }
    if (indexed.type === "val" && queried.type === "val") {
        return Object.is(indexed.value, queried.value);
    }
    if (indexed.type === "func" && queried.type === "func") {
        return (
            indexed.name === queried.name &&
            indexed.args.length === queried.args.length &&
            indexed.args.every((argument, index) =>
                expressionsMatch(argument, queried.args[index]!)
            )
        );
    }
    return false;
}

function buildIndexRecords(
    definition: Omit<
        IndexDefinitionRecord,
        "hasUnsupportedValues" | "valueTypes"
    >,
    rows: readonly RowRecord[]
): {
    definition: IndexDefinitionRecord;
    entries: IndexEntryRecord[];
} {
    const evaluate = compileSingleRowExpression(definition.expression);
    const entries: IndexEntryRecord[] = [];
    const valueTypes = new Set<IndexValueType>();
    let hasUnsupportedValues = false;

    for (const row of rows) {
        const encoded = encodeIndexValue(evaluate(row.value) as unknown);
        if (!encoded) {
            hasUnsupportedValues = true;
            continue;
        }
        valueTypes.add(encoded.type);
        entries.push({
            collectionId: definition.collectionId,
            signature: definition.signature,
            valueType: encoded.type,
            rowId: row.id,
            value: encoded.value,
        });
        if (encoded.type === "string") {
            valueTypes.add("string-ci");
            entries.push({
                collectionId: definition.collectionId,
                signature: definition.signature,
                valueType: "string-ci",
                rowId: row.id,
                value: String(encoded.value).toLowerCase(),
            });
        }
    }

    return {
        definition: {
            ...definition,
            valueTypes: [...valueTypes],
            hasUnsupportedValues,
        },
        entries,
    };
}

function isIndexPlan(value: unknown): value is IndexPlan {
    return (
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        ["and", "lookup", "none", "or"].includes(String(value.kind))
    );
}

function exactRange(
    definition: IndexDefinitionRecord,
    encoded: EncodedIndexValue,
    valueType: IndexValueType = encoded.type
): IDBKeyRange {
    return IDBKeyRange.only([
        definition.collectionId,
        definition.signature,
        valueType,
        encoded.value,
    ]);
}

function boundedRange(
    definition: IndexDefinitionRecord,
    operator: "gt" | "gte" | "lt" | "lte",
    encoded: EncodedIndexValue
): IDBKeyRange {
    const prefix = [
        definition.collectionId,
        definition.signature,
        encoded.type,
    ] as const;
    const key: [string, string, IndexValueType, IndexValue] = [
        ...prefix,
        encoded.value,
    ];
    const minimum: [string, string, IndexValueType, IndexValue] = [
        ...prefix,
        -Infinity,
    ];
    const maximum: [string, string, IndexValueType, IDBValidKey] = [
        ...prefix,
        [],
    ];
    switch (operator) {
        case "gt":
            return IDBKeyRange.bound(key, maximum, true, false);
        case "gte":
            return IDBKeyRange.bound(key, maximum, false, false);
        case "lt":
            return IDBKeyRange.bound(minimum, key, false, true);
        case "lte":
            return IDBKeyRange.bound(minimum, key, false, false);
    }
}

function stringPrefixRange(
    definition: IndexDefinitionRecord,
    prefix: string,
    valueType: "string" | "string-ci"
): IDBKeyRange {
    return IDBKeyRange.bound(
        [
            definition.collectionId,
            definition.signature,
            valueType,
            prefix,
        ],
        [
            definition.collectionId,
            definition.signature,
            valueType,
            `${prefix}\uffff`,
        ]
    );
}

function compatibleRangeType(
    definition: IndexDefinitionRecord,
    valueType: IndexValueType
): boolean {
    if (
        definition.hasUnsupportedValues ||
        ["bigint", "nan", "null", "string-ci", "undefined"].includes(
            valueType
        )
    ) {
        return false;
    }
    return definition.valueTypes
        .filter(
            (type) =>
                type !== "null" &&
                type !== "string-ci" &&
                type !== "undefined"
        )
        .every((type) => type === valueType);
}

function matchingDefinition(
    definitions: readonly IndexDefinitionRecord[],
    expression: IR.BasicExpression,
    valueType: IndexValueType
): IndexDefinitionRecord | undefined {
    return definitions.find(
        (definition) =>
            definition.valueTypes.includes(valueType) &&
            expressionsMatch(definition.expression, expression)
    );
}

function lookupPlan(
    definitions: readonly IndexDefinitionRecord[],
    operator: "eq" | "gt" | "gte" | "lt" | "lte",
    field: unknown,
    value: unknown
): IndexPlan | undefined {
    const expression = toExpression(field);
    const encoded = encodeIndexValue(value);
    if (!encoded) return undefined;
    const definition = matchingDefinition(
        definitions,
        expression,
        encoded.type
    );
    if (!definition) return undefined;
    if (
        operator !== "eq" &&
        !compatibleRangeType(definition, encoded.type)
    ) {
        return undefined;
    }
    return {
        kind: "lookup",
        definition,
        ranges: [
            operator === "eq"
                ? exactRange(definition, encoded)
                : boundedRange(definition, operator, encoded),
        ],
    };
}

function inPlan(
    definitions: readonly IndexDefinitionRecord[],
    field: unknown,
    values: unknown
): IndexPlan | undefined {
    if (!Array.isArray(values)) return undefined;
    if (values.length === 0) return { kind: "none" };
    const expression = toExpression(field);
    const encodedValues = values
        .map(encodeIndexValue)
        .filter((value): value is EncodedIndexValue => value !== undefined);
    if (encodedValues.length !== values.length) return undefined;
    const ranges: IDBKeyRange[] = [];
    let firstDefinition: IndexDefinitionRecord | undefined;
    for (const encoded of encodedValues) {
        const definition = matchingDefinition(
            definitions,
            expression,
            encoded.type
        );
        if (!definition) return undefined;
        firstDefinition ??= definition;
        ranges.push(exactRange(definition, encoded));
    }
    return {
        kind: "lookup",
        definition: firstDefinition,
        ranges,
    };
}

function nullPlan(
    definitions: readonly IndexDefinitionRecord[],
    field: unknown,
    valueType: "null" | "undefined"
): IndexPlan | undefined {
    const definition = matchingDefinition(
        definitions,
        toExpression(field),
        valueType
    );
    return definition
        ? {
              kind: "lookup",
              definition,
              ranges: [
                  exactRange(definition, {
                      type: valueType,
                      value: 0,
                  }),
              ],
          }
        : undefined;
}

function likePlan(
    definitions: readonly IndexDefinitionRecord[],
    field: unknown,
    pattern: unknown,
    caseInsensitive: boolean
): IndexPlan | undefined {
    if (typeof pattern !== "string") return undefined;
    const valueType = caseInsensitive ? "string-ci" : "string";
    const definition = matchingDefinition(
        definitions,
        toExpression(field),
        valueType
    );
    if (!definition) return undefined;
    const normalized = caseInsensitive ? pattern.toLowerCase() : pattern;
    const wildcardIndex = normalized.search(/[%_]/);
    if (wildcardIndex === -1) {
        return {
            kind: "lookup",
            definition,
            ranges: [
                exactRange(
                    definition,
                    { type: "string", value: normalized },
                    valueType
                ),
            ],
        };
    }
    if (wildcardIndex === 0) return undefined;
    return {
        kind: "lookup",
        definition,
        ranges: [
            stringPrefixRange(
                definition,
                normalized.slice(0, wildcardIndex),
                valueType
            ),
        ],
    };
}

function combineAnd(values: unknown[]): IndexPlan | undefined {
    const children = values.filter(isIndexPlan);
    if (children.some((child) => child.kind === "none")) {
        return { kind: "none" };
    }
    if (children.length === 0) return undefined;
    return children.length === 1
        ? children[0]
        : { kind: "and", children };
}

function combineOr(values: unknown[]): IndexPlan | undefined {
    if (values.some((value) => !isIndexPlan(value))) return undefined;
    const children = values
        .filter(isIndexPlan)
        .filter((child) => child.kind !== "none");
    if (children.length === 0) return { kind: "none" };
    return children.length === 1
        ? children[0]
        : { kind: "or", children };
}

function selectIndexPlan(
    definitions: readonly IndexDefinitionRecord[],
    options: LoadSubsetOptions
): IndexPlan | undefined {
    if (!options.where) return undefined;

    const expressionHandler =
        (name: string) =>
        (...values: unknown[]): ExpressionOperand => ({
            kind: "expression",
            expression: new IR.Func(name, values.map(toExpression)),
        });
    const parsed = parseWhereExpression<unknown>(options.where, {
        handlers: {
            add: expressionHandler("add"),
            and: (...values: unknown[]) => combineAnd(values),
            coalesce: expressionHandler("coalesce"),
            concat: expressionHandler("concat"),
            divide: expressionHandler("divide"),
            eq: (field: unknown, value: unknown) =>
                lookupPlan(definitions, "eq", field, value),
            gt: (field: unknown, value: unknown) =>
                lookupPlan(definitions, "gt", field, value),
            gte: (field: unknown, value: unknown) =>
                lookupPlan(definitions, "gte", field, value),
            ilike: (field: unknown, pattern: unknown) =>
                likePlan(definitions, field, pattern, true),
            in: (field: unknown, values: unknown) =>
                inPlan(definitions, field, values),
            isNull: (field: unknown) =>
                nullPlan(definitions, field, "null"),
            isUndefined: (field: unknown) =>
                nullPlan(definitions, field, "undefined"),
            length: expressionHandler("length"),
            like: (field: unknown, pattern: unknown) =>
                likePlan(definitions, field, pattern, false),
            lower: expressionHandler("lower"),
            lt: (field: unknown, value: unknown) =>
                lookupPlan(definitions, "lt", field, value),
            lte: (field: unknown, value: unknown) =>
                lookupPlan(definitions, "lte", field, value),
            multiply: expressionHandler("multiply"),
            not: () => undefined,
            or: (...values: unknown[]) => combineOr(values),
            subtract: expressionHandler("subtract"),
            upper: expressionHandler("upper"),
        },
        onUnknownOperator: () => undefined,
    });
    return isIndexPlan(parsed) ? parsed : undefined;
}

export class IndexedDBPersistenceAdapter implements PersistenceAdapter {
    private databasePromise?: Promise<IDBPDatabase<RuntimePersistenceDB>>;
    private closed = false;

    constructor(private readonly options: IndexedDBPersistenceAdapterOptions) {}

    async loadSubset(collectionId: string, options: LoadSubsetOptions): Promise<PersistedRow[]> {
        const database = await this.database();
        const transaction = database.transaction([ROWS, INDEX_DEFINITIONS, INDEX_ENTRIES], "readonly");
        const definitions = await transaction
            .objectStore(INDEX_DEFINITIONS)
            .index(BY_COLLECTION)
            .getAll(collectionId);
        const plan = selectIndexPlan(definitions, options);

        let rows: RowRecord[];
        if (plan) {
            const lookup = transaction
                .objectStore(INDEX_ENTRIES)
                .index(BY_LOOKUP);

            async function estimatePlan(current: IndexPlan): Promise<number> {
                if (current.kind === "none") return 0;
                if (current.kind === "lookup") {
                    const counts = await Promise.all(
                        (current.ranges ?? []).map((range) =>
                            lookup.count(range)
                        )
                    );
                    return counts.reduce((total, count) => total + count, 0);
                }
                const estimates = await Promise.all(
                    (current.children ?? []).map(estimatePlan)
                );
                return current.kind === "and"
                    ? Math.min(...estimates)
                    : estimates.reduce((total, count) => total + count, 0);
            }

            async function iteratePlan(
                current: IndexPlan,
                visit: (rowId: string) => void
            ): Promise<void> {
                if (current.kind === "none") return;
                if (current.kind === "lookup") {
                    for (const range of current.ranges ?? []) {
                        for await (const cursor of lookup.iterate(range)) {
                            visit(cursor.value.rowId);
                        }
                    }
                    return;
                }
                if (current.kind === "or") {
                    for (const child of current.children ?? []) {
                        await iteratePlan(child, visit);
                    }
                    return;
                }
                const rowIds = await executePlan(current);
                for (const rowId of rowIds) visit(rowId);
            }

            async function executePlan(
                current: IndexPlan
            ): Promise<Set<string>> {
                if (current.kind !== "and") {
                    const rowIds = new Set<string>();
                    await iteratePlan(current, (rowId) => rowIds.add(rowId));
                    return rowIds;
                }

                const children = current.children ?? [];
                const estimated = await Promise.all(
                    children.map(async (child) => ({
                        child,
                        count: await estimatePlan(child),
                    }))
                );
                estimated.sort((left, right) => left.count - right.count);
                const [first, ...rest] = estimated;
                if (!first) return new Set();

                let rowIds = await executePlan(first.child);
                for (const { child } of rest) {
                    const intersection = new Set<string>();
                    await iteratePlan(child, (rowId) => {
                        if (rowIds.has(rowId)) intersection.add(rowId);
                    });
                    rowIds = intersection;
                    if (rowIds.size === 0) break;
                }
                return rowIds;
            }

            const rowIds = await executePlan(plan);
            rows = [];
            const rowStore = transaction.objectStore(ROWS);
            for (const key of rowIds) {
                const row = await rowStore.get(key);
                if (row) rows.push(row);
            }
        } else {
            rows = await transaction.objectStore(ROWS).index(BY_COLLECTION).getAll(collectionId);
        }
        await transaction.done;
        return rows.map(({ key, value, metadata }) => ({
            key,
            value: decodePersistedValue(value) as Record<string, unknown>,
            metadata: decodePersistedValue(metadata),
        }));
    }

    async applyCommittedTx(collectionId: string, committed: PersistedTx): Promise<void> {
        const database = await this.database();
        const transaction = database.transaction(
            [ROWS, TRANSACTIONS, COLLECTION_METADATA, STREAMS, INDEX_DEFINITIONS, INDEX_ENTRIES],
            "readwrite"
        );
        const transactionId = id(collectionId, committed.txId);
        const [previous, storedRows, storedMetadata, stream, definitions] = await Promise.all([
            transaction.objectStore(TRANSACTIONS).get(transactionId),
            transaction.objectStore(ROWS).index(BY_COLLECTION).getAll(collectionId),
            transaction.objectStore(COLLECTION_METADATA).index(BY_COLLECTION).getAll(collectionId),
            transaction.objectStore(STREAMS).get(collectionId),
            transaction.objectStore(INDEX_DEFINITIONS).index(BY_COLLECTION).getAll(collectionId),
        ]);

        if (previous) {
            await transaction.done;
            return;
        }

        const rows = new Map(
            storedRows.map((row) => [
                encodePersistedStorageKey(row.key),
                {
                    ...row,
                    value: decodePersistedValue(row.value) as Record<
                        string,
                        unknown
                    >,
                    metadata: decodePersistedValue(row.metadata),
                },
            ])
        );
        if (committed.truncate) rows.clear();

        for (const mutation of committed.mutations) {
            const encodedKey = encodePersistedStorageKey(mutation.key);
            if (mutation.type === "delete") {
                rows.delete(encodedKey);
                continue;
            }
            const existing = rows.get(encodedKey);
            rows.set(encodedKey, {
                id: rowId(collectionId, mutation.key),
                collectionId,
                key: mutation.key,
                value: mutation.value,
                metadata:
                    mutation.metadataChanged || mutation.type === "insert"
                        ? mutation.metadata
                        : (mutation.metadata ?? existing?.metadata),
            });
        }

        for (const mutation of committed.rowMetadataMutations ?? []) {
            const row = rows.get(encodePersistedStorageKey(mutation.key));
            if (!row) continue;
            if (mutation.type === "delete") delete row.metadata;
            else row.metadata = mutation.value;
        }

        const rowStore = transaction.objectStore(ROWS);
        await Promise.all(storedRows.map((row) => rowStore.delete(row.id)));
        await Promise.all(
            [...rows.values()].map((row) =>
                rowStore.put({
                    ...row,
                    value: encodePersistedValue(row.value) as Record<
                        string,
                        unknown
                    >,
                    metadata: encodePersistedValue(row.metadata),
                })
            )
        );

        const metadata = new Map(
            storedMetadata.map((record) => [
                record.key,
                {
                    ...record,
                    value: decodePersistedValue(record.value),
                },
            ])
        );
        for (const mutation of committed.collectionMetadataMutations ?? []) {
            if (mutation.type === "delete") {
                metadata.delete(mutation.key);
            } else {
                metadata.set(mutation.key, {
                    id: id(collectionId, mutation.key),
                    collectionId,
                    key: mutation.key,
                    value: mutation.value,
                });
            }
        }
        const metadataStore = transaction.objectStore(COLLECTION_METADATA);
        await Promise.all(storedMetadata.map((record) => metadataStore.delete(record.id)));
        await Promise.all(
            [...metadata.values()].map((record) =>
                metadataStore.put({
                    ...record,
                    value: encodePersistedValue(record.value),
                })
            )
        );

        const indexEntryStore = transaction.objectStore(INDEX_ENTRIES);
        const existingIndexKeys = await indexEntryStore.index(BY_COLLECTION).getAllKeys(collectionId);
        await Promise.all(existingIndexKeys.map((key) => indexEntryStore.delete(key)));
        const definitionStore = transaction.objectStore(INDEX_DEFINITIONS);
        for (const definition of definitions) {
            const built = buildIndexRecords(definition, [...rows.values()]);
            await definitionStore.put(built.definition);
            await Promise.all(built.entries.map((entry) => indexEntryStore.put(entry)));
        }

        await transaction.objectStore(TRANSACTIONS).put({
            id: transactionId,
            collectionId,
        });
        await transaction.objectStore(STREAMS).put({
            collectionId,
            latestTerm: Math.max(stream?.latestTerm ?? 0, committed.term),
            latestSeq:
                committed.term > (stream?.latestTerm ?? 0)
                    ? committed.seq
                    : committed.term === (stream?.latestTerm ?? 0)
                      ? Math.max(stream?.latestSeq ?? 0, committed.seq)
                      : (stream?.latestSeq ?? 0),
            latestRowVersion: Math.max(stream?.latestRowVersion ?? 0, committed.rowVersion),
        });
        await transaction.done;
    }

    async loadCollectionMetadata(collectionId: string): Promise<Array<{ key: string; value: unknown }>> {
        const database = await this.database();
        const records = await database.getAllFromIndex(COLLECTION_METADATA, BY_COLLECTION, collectionId);
        return records.map(({ key, value }) => ({
            key,
            value: decodePersistedValue(value),
        }));
    }

    async scanRows(collectionId: string): Promise<PersistedRow[]> {
        return this.loadSubset(collectionId, {});
    }

    async ensureIndex(collectionId: string, signature: string, spec: PersistedIndexSpec): Promise<void> {
        const database = await this.database();
        const expression = parseIndexExpression(spec);
        const transaction = database.transaction([ROWS, INDEX_DEFINITIONS, INDEX_ENTRIES], "readwrite");
        const rows = await transaction.objectStore(ROWS).index(BY_COLLECTION).getAll(collectionId);
        const built = buildIndexRecords(
            {
                collectionId,
                signature,
                expression,
            },
            rows.map((row) => ({
                ...row,
                value: decodePersistedValue(row.value) as Record<
                    string,
                    unknown
                >,
                metadata: decodePersistedValue(row.metadata),
            }))
        );
        const entryStore = transaction.objectStore(INDEX_ENTRIES);
        const existingKeys = await entryStore.index(BY_INDEX).getAllKeys([collectionId, signature]);
        await Promise.all(existingKeys.map((key) => entryStore.delete(key)));
        await Promise.all(built.entries.map((entry) => entryStore.put(entry)));
        await transaction.objectStore(INDEX_DEFINITIONS).put(built.definition);
        await transaction.done;
    }

    async markIndexRemoved(collectionId: string, signature: string): Promise<void> {
        const database = await this.database();
        const transaction = database.transaction([INDEX_DEFINITIONS, INDEX_ENTRIES], "readwrite");
        await transaction.objectStore(INDEX_DEFINITIONS).delete([collectionId, signature]);
        const entryStore = transaction.objectStore(INDEX_ENTRIES);
        const keys = await entryStore.index(BY_INDEX).getAllKeys([collectionId, signature]);
        await Promise.all(keys.map((key) => entryStore.delete(key)));
        await transaction.done;
    }

    async getStreamPosition(collectionId: string): Promise<StreamRecord> {
        const database = await this.database();
        return (
            (await database.get(STREAMS, collectionId)) ?? {
                collectionId,
                latestTerm: 0,
                latestSeq: 0,
                latestRowVersion: 0,
            }
        );
    }

    close(): void {
        this.closed = true;
        void this.databasePromise?.then((database) => database.close());
        this.databasePromise = undefined;
    }

    private database(): Promise<IDBPDatabase<RuntimePersistenceDB>> {
        if (this.closed) {
            return Promise.reject(new Error("IndexedDB persistence adapter is closed."));
        }
        this.databasePromise ??= openDB<RuntimePersistenceDB>(this.options.databaseName, DATABASE_VERSION, {
            upgrade(database) {
                const rows = database.createObjectStore(ROWS, {
                    keyPath: "id",
                });
                rows.createIndex(BY_COLLECTION, "collectionId");
                const transactions = database.createObjectStore(TRANSACTIONS, { keyPath: "id" });
                transactions.createIndex(BY_COLLECTION, "collectionId");
                const metadata = database.createObjectStore(COLLECTION_METADATA, { keyPath: "id" });
                metadata.createIndex(BY_COLLECTION, "collectionId");
                database.createObjectStore(STREAMS, {
                    keyPath: "collectionId",
                });

                const definitions = database.createObjectStore(INDEX_DEFINITIONS, {
                    keyPath: ["collectionId", "signature"],
                });
                definitions.createIndex(BY_COLLECTION, "collectionId");
                const entries = database.createObjectStore(INDEX_ENTRIES, {
                    keyPath: [
                        "collectionId",
                        "signature",
                        "valueType",
                        "rowId",
                    ],
                });
                entries.createIndex(BY_COLLECTION, "collectionId");
                entries.createIndex(BY_INDEX, ["collectionId", "signature"]);
                entries.createIndex(BY_LOOKUP, [
                    "collectionId",
                    "signature",
                    "valueType",
                    "value",
                ]);
            },
            blocked: () => this.options.onBlocked?.(),
            blocking: (_currentVersion, _blockedVersion, event) => {
                this.options.onVersionChange?.(event);
                void this.databasePromise?.then((database) => database.close());
                this.databasePromise = undefined;
            },
        });
        return this.databasePromise;
    }
}
