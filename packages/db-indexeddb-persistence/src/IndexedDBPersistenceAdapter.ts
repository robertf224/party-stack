import { IR, compileSingleRowExpression, parseWhereExpression } from "@tanstack/db";
import {
    encodePersistedStorageKey,
    type PersistedIndexSpec,
    type PersistedRowScanOptions,
    type PersistencePullSinceResult,
    type ReplayableTxDelta,
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

const DATABASE_VERSION = 2;
const ROWS = "rows";
const TRANSACTIONS = "transactions";
const COLLECTION_METADATA = "collectionMetadata";
const STREAMS = "streams";
const INDEX_DEFINITIONS = "indexDefinitions";
const INDEX_ENTRIES = "indexEntries";
const BY_COLLECTION = "collectionId";
const BY_INDEX = "index";
const BY_METADATA = "metadata";
const BY_VERSION = "version";
const BY_LOOKUP = "lookup";
const INDEX_BATCH_SIZE = 300;
const INDEX_ENCODING_VERSION = 2;

interface RowRecord extends PersistedRow {
    hasMetadata?: number;
    id: string;
    collectionId: string;
}

interface TransactionRecord {
    id: string;
    collectionId: string;
    rowVersion?: number;
    appliedAt?: number;
    delta?: ReplayableTxDelta | null;
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
    schemaVersion?: number;
    resetEpoch?: number;
    replayFloor?: number;
}

interface IndexDefinitionRecord {
    collectionId: string;
    signature: string;
    expression: IR.BasicExpression;
    valueTypes: IndexValueType[];
    hasUnsupportedValues: boolean;
    valueTypeCounts?: Partial<Record<IndexValueType, number>>;
    unsupportedValueCount?: number;
    encodingVersion?: number;
}

interface IndexEntryRecord {
    collectionId: string;
    signature: string;
    valueType: IndexValueType;
    rowId: string;
    value: IndexValue;
}

interface IndexedDBPersistenceDB extends DBSchema {
    rows: {
        key: string;
        value: RowRecord;
        indexes: { collectionId: string; metadata: [string, number] };
    };
    transactions: {
        key: string;
        value: TransactionRecord;
        indexes: { collectionId: string; version: [string, number] };
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
            lookup: [string, string, IndexValueType, IndexValue, string];
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
    schemaVersion?: number;
    schemaMismatchPolicy?: "sync-present-reset" | "sync-absent-error" | "reset";
    /** Retry deduplication and replay are retained for this bounded window. */
    appliedTxPruneMaxRows?: number;
    appliedTxPruneMaxAgeSeconds?: number;
    pullSinceReloadThreshold?: number;
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
    const tag = (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag];
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
                Object.entries(value).map(([key, entry]) => [key, encodePersistedValue(entry)])
            );
        }
    }
    return value;
}

function decodePersistedValue(value: unknown): unknown {
    if (typeof value === "object" && value !== null && PERSISTED_TYPE in value && "value" in value) {
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
                Object.entries(value).map(([key, entry]) => [key, decodePersistedValue(entry)])
            );
        }
    }
    return value;
}

function encodeIndexValue(value: unknown): EncodedIndexValue | undefined {
    const tag = temporalTag(value);
    if (tag === "Temporal.PlainDate") {
        const date = Temporal.PlainDate.from(String(value)).withCalendar("iso8601");
        return {
            type: "temporal-plain-date",
            value: `${String(date.year + 1_000_000).padStart(7, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`,
        };
    }
    if (tag === "Temporal.Instant") {
        return {
            type: "temporal-instant",
            // Shift the full supported range positive so fixed-width strings
            // retain nanosecond ordering in IndexedDB's lexical key order.
            value: String(
                Temporal.Instant.from(String(value)).epochNanoseconds + 8_640_000_000_000_000_000_000n
            ).padStart(23, "0"),
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
        return Number.isNaN(value.getTime()) ? { type: "nan", value: 0 } : { type: "date", value };
    }
    return undefined;
}

interface ExpressionOperand {
    kind: "expression";
    expression: IR.BasicExpression;
}

function pathsMatch(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((part, index) => right[index] === part);
}

function unqualifiedExpression<T>(expression: IR.BasicExpression<T>): IR.BasicExpression<T> {
    if (expression.type === "ref") return new IR.PropRef<T>(IR.getPropRefPropertyPath(expression));
    if (expression.type === "func")
        return new IR.Func<T>(expression.name, expression.args.map(unqualifiedExpression));
    return expression;
}

function parseIndexExpression(spec: PersistedIndexSpec): IR.BasicExpression {
    const serialized = spec.expressionSql[0];
    if (!serialized) {
        throw new Error("Persisted index spec is missing its expression.");
    }
    return JSON.parse(serialized) as IR.BasicExpression;
}

function isExpressionOperand(value: unknown): value is ExpressionOperand {
    return typeof value === "object" && value !== null && "kind" in value && value.kind === "expression";
}

function toExpression(value: unknown): IR.BasicExpression {
    if (isExpressionOperand(value)) return value.expression;
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
        return new IR.PropRef(value);
    }
    return new IR.Value(value);
}

function expressionsMatch(indexed: IR.BasicExpression, queried: IR.BasicExpression): boolean {
    if (indexed.type !== queried.type) return false;
    if (indexed.type === "ref" && queried.type === "ref") {
        return pathsMatch(IR.getPropRefPropertyPath(indexed), IR.getPropRefPropertyPath(queried));
    }
    if (indexed.type === "val" && queried.type === "val") {
        return Object.is(indexed.value, queried.value);
    }
    if (indexed.type === "func" && queried.type === "func") {
        return (
            indexed.name === queried.name &&
            indexed.args.length === queried.args.length &&
            indexed.args.every((argument, index) => expressionsMatch(argument, queried.args[index]!))
        );
    }
    return false;
}

function buildIndexRecords(
    definition: Omit<IndexDefinitionRecord, "hasUnsupportedValues" | "valueTypes">,
    rows: readonly RowRecord[]
): {
    definition: IndexDefinitionRecord;
    entries: IndexEntryRecord[];
} {
    const evaluate = compileSingleRowExpression(definition.expression);
    const entries: IndexEntryRecord[] = [];
    const valueTypeCounts: Partial<Record<IndexValueType, number>> = {};
    let unsupportedValueCount = 0;

    for (const row of rows) {
        const encoded = encodeIndexValue(evaluate(row.value) as unknown);
        if (!encoded) {
            unsupportedValueCount += 1;
            continue;
        }
        valueTypeCounts[encoded.type] = (valueTypeCounts[encoded.type] ?? 0) + 1;
        entries.push({
            collectionId: definition.collectionId,
            signature: definition.signature,
            valueType: encoded.type,
            rowId: row.id,
            value: encoded.value,
        });
        if (encoded.type === "string") {
            valueTypeCounts["string-ci"] = (valueTypeCounts["string-ci"] ?? 0) + 1;
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
            valueTypes: Object.keys(valueTypeCounts) as IndexValueType[],
            hasUnsupportedValues: unsupportedValueCount > 0,
            valueTypeCounts,
            unsupportedValueCount,
            encodingVersion: INDEX_ENCODING_VERSION,
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
    return IDBKeyRange.bound(
        [definition.collectionId, definition.signature, valueType, encoded.value, ""],
        [definition.collectionId, definition.signature, valueType, encoded.value, []]
    );
}

function boundedRange(
    definition: IndexDefinitionRecord,
    operator: "gt" | "gte" | "lt" | "lte",
    encoded: EncodedIndexValue
): IDBKeyRange {
    const prefix = [definition.collectionId, definition.signature, encoded.type] as const;
    const keyStart: [string, string, IndexValueType, IndexValue, string] = [...prefix, encoded.value, ""];
    const keyEnd: [string, string, IndexValueType, IndexValue, IDBValidKey] = [...prefix, encoded.value, []];
    const minimum: [string, string, IndexValueType, IndexValue, string] = [...prefix, -Infinity, ""];
    const maximum: [string, string, IndexValueType, IDBValidKey, IDBValidKey] = [...prefix, [], []];
    switch (operator) {
        case "gt":
            return IDBKeyRange.bound(keyEnd, maximum);
        case "gte":
            return IDBKeyRange.bound(keyStart, maximum);
        case "lt":
            return IDBKeyRange.bound(minimum, keyStart, false, true);
        case "lte":
            return IDBKeyRange.bound(minimum, keyEnd);
    }
}

function stringPrefixRange(
    definition: IndexDefinitionRecord,
    prefix: string,
    valueType: "string" | "string-ci"
): IDBKeyRange {
    return IDBKeyRange.bound(
        [definition.collectionId, definition.signature, valueType, prefix, ""],
        [definition.collectionId, definition.signature, valueType, `${prefix}\uffff`, []]
    );
}

function rangeAfter(range: IDBKeyRange, entry: IndexEntryRecord): IDBKeyRange | undefined {
    const checkpoint: [string, string, IndexValueType, IndexValue, string] = [
        entry.collectionId,
        entry.signature,
        entry.valueType,
        entry.value,
        entry.rowId,
    ];
    if (range.upper !== undefined && indexedDB.cmp(checkpoint, range.upper) >= 0) {
        return undefined;
    }
    return range.upper === undefined
        ? IDBKeyRange.lowerBound(checkpoint, true)
        : IDBKeyRange.bound(checkpoint, range.upper, true, range.upperOpen);
}

function compatibleRangeType(definition: IndexDefinitionRecord, valueType: IndexValueType): boolean {
    if (
        definition.hasUnsupportedValues ||
        ["bigint", "nan", "null", "string-ci", "undefined"].includes(valueType)
    ) {
        return false;
    }
    return definition.valueTypes
        .filter((type) => type !== "null" && type !== "string-ci" && type !== "undefined")
        .every((type) => type === valueType);
}

function matchingDefinition(
    definitions: readonly IndexDefinitionRecord[],
    expression: IR.BasicExpression,
    valueType: IndexValueType
): IndexDefinitionRecord | undefined {
    return definitions.find(
        (definition) =>
            definition.valueTypes.includes(valueType) && expressionsMatch(definition.expression, expression)
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
    const definition = matchingDefinition(definitions, expression, encoded.type);
    if (!definition) return undefined;
    if (operator !== "eq" && !compatibleRangeType(definition, encoded.type)) {
        return undefined;
    }
    return {
        kind: "lookup",
        definition,
        ranges: [
            operator === "eq" ? exactRange(definition, encoded) : boundedRange(definition, operator, encoded),
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
        const definition = matchingDefinition(definitions, expression, encoded.type);
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
    const definition = matchingDefinition(definitions, toExpression(field), valueType);
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
    const definition = matchingDefinition(definitions, toExpression(field), valueType);
    if (!definition) return undefined;
    const normalized = caseInsensitive ? pattern.toLowerCase() : pattern;
    const wildcardIndex = normalized.search(/[%_]/);
    if (wildcardIndex === -1) {
        return {
            kind: "lookup",
            definition,
            ranges: [exactRange(definition, { type: "string", value: normalized }, valueType)],
        };
    }
    if (wildcardIndex === 0) return undefined;
    return {
        kind: "lookup",
        definition,
        ranges: [stringPrefixRange(definition, normalized.slice(0, wildcardIndex), valueType)],
    };
}

function combineAnd(values: unknown[]): IndexPlan | undefined {
    const children = values.filter(isIndexPlan);
    if (children.some((child) => child.kind === "none")) {
        return { kind: "none" };
    }
    if (children.length === 0) return undefined;
    return children.length === 1 ? children[0] : { kind: "and", children };
}

function combineOr(values: unknown[]): IndexPlan | undefined {
    if (values.some((value) => !isIndexPlan(value))) return undefined;
    const children = values.filter(isIndexPlan).filter((child) => child.kind !== "none");
    if (children.length === 0) return { kind: "none" };
    return children.length === 1 ? children[0] : { kind: "or", children };
}

function selectIndexPlan(
    definitions: readonly IndexDefinitionRecord[],
    options: LoadSubsetOptions
): IndexPlan | undefined {
    const predicates = [options.where, options.cursor?.whereFrom].filter(
        (predicate): predicate is IR.BasicExpression<boolean> => predicate !== undefined
    );
    if (predicates.length === 0) return undefined;

    const expressionHandler =
        (name: string) =>
        (...values: unknown[]): ExpressionOperand => ({
            kind: "expression",
            expression: new IR.Func(name, values.map(toExpression)),
        });
    const parsePredicate = (predicate: IR.BasicExpression<boolean>): IndexPlan | undefined => {
        const parsed = parseWhereExpression<unknown>(unqualifiedExpression(predicate), {
            handlers: {
                add: expressionHandler("add"),
                and: (...values: unknown[]) => combineAnd(values),
                coalesce: expressionHandler("coalesce"),
                concat: expressionHandler("concat"),
                divide: expressionHandler("divide"),
                eq: (field: unknown, value: unknown) => lookupPlan(definitions, "eq", field, value),
                gt: (field: unknown, value: unknown) => lookupPlan(definitions, "gt", field, value),
                gte: (field: unknown, value: unknown) => lookupPlan(definitions, "gte", field, value),
                ilike: (field: unknown, pattern: unknown) => likePlan(definitions, field, pattern, true),
                in: (field: unknown, values: unknown) => inPlan(definitions, field, values),
                isNull: (field: unknown) => nullPlan(definitions, field, "null"),
                isUndefined: (field: unknown) => nullPlan(definitions, field, "undefined"),
                length: expressionHandler("length"),
                like: (field: unknown, pattern: unknown) => likePlan(definitions, field, pattern, false),
                lower: expressionHandler("lower"),
                lt: (field: unknown, value: unknown) => lookupPlan(definitions, "lt", field, value),
                lte: (field: unknown, value: unknown) => lookupPlan(definitions, "lte", field, value),
                multiply: expressionHandler("multiply"),
                not: () => undefined,
                or: (...values: unknown[]) => combineOr(values),
                subtract: expressionHandler("subtract"),
                upper: expressionHandler("upper"),
            },
            onUnknownOperator: () => undefined,
        });
        return isIndexPlan(parsed) ? parsed : undefined;
    };

    return combineAnd(predicates.map(parsePredicate));
}

function decodeRow({ key, value, metadata }: PersistedRow): PersistedRow {
    return {
        key,
        value: decodePersistedValue(value) as Record<string, unknown>,
        metadata: decodePersistedValue(metadata),
    };
}

function compareKeys(left: PersistedRow, right: PersistedRow): number {
    const a = encodePersistedStorageKey(left.key);
    const b = encodePersistedStorageKey(right.key);
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareOrderValues(
    left: unknown,
    right: unknown,
    options: IR.OrderByClause["compareOptions"]
): number {
    if (left == null && right == null) return 0;
    if (left == null) return options.nulls === "first" ? -1 : 1;
    if (right == null) return options.nulls === "first" ? 1 : -1;
    let comparison: number;
    const a = encodeIndexValue(left)!;
    const b = encodeIndexValue(right)!;
    if (a.type === "nan" || b.type === "nan") comparison = a.type === b.type ? 0 : a.type === "nan" ? 1 : -1;
    else if (typeof left === "string" && typeof right === "string" && options.stringSort === "custom")
        comparison = options.compare(left, right);
    else if (typeof left === "string" && typeof right === "string" && options.stringSort !== "lexical")
        comparison = left.localeCompare(
            right,
            options.stringSort === "locale" ? options.locale : undefined,
            options.stringSort === "locale" ? options.localeOptions : undefined
        );
    else if (a.type === b.type && a.type !== "bigint")
        comparison = a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    else
        comparison =
            (left as string | number | bigint | boolean) < (right as string | number | bigint | boolean)
                ? -1
                : (left as string | number | bigint | boolean) > (right as string | number | bigint | boolean)
                  ? 1
                  : 0;
    return options.direction === "desc" ? -comparison : comparison;
}

/** Unsupported object identity ordering must keep the full source available to the live query. */
function orderRows(
    rows: PersistedRow[],
    orderBy: IR.OrderBy | undefined
): { rows: PersistedRow[]; supported: boolean } {
    const clauses = (orderBy ?? []).map((clause) => ({
        ...clause,
        evaluate: compileSingleRowExpression(clause.expression),
    }));
    if (
        clauses.some((clause) => {
            const types = new Set(rows.map((row) => encodeIndexValue(clause.evaluate(row.value))?.type));
            if (types.has(undefined)) return true;
            const objectTypes = ["date", "temporal-instant", "temporal-plain-date"];
            const nonNull = [...types].filter((type) => type !== "null" && type !== "undefined");
            return nonNull.length > 1 && nonNull.some((type) => objectTypes.includes(type!));
        })
    )
        return { rows, supported: false };
    return {
        supported: true,
        rows: clauses.length
            ? [...rows].sort((a, b) => {
                  for (const clause of clauses) {
                      const comparison = compareOrderValues(
                          clause.evaluate(a.value),
                          clause.evaluate(b.value),
                          clause.compareOptions
                      );
                      if (comparison) return comparison;
                  }
                  return compareKeys(a, b);
              })
            : rows,
    };
}

export class IndexedDBPersistenceAdapter implements PersistenceAdapter {
    private databasePromise?: Promise<IDBPDatabase<IndexedDBPersistenceDB>>;
    private closed = false;

    private readonly initialized = new Map<string, Promise<number>>();
    readonly schemaVersion: number;

    constructor(private readonly options: IndexedDBPersistenceAdapterOptions) {
        this.schemaVersion = options.schemaVersion ?? 1;
        for (const [name, value] of Object.entries({
            schemaVersion: this.schemaVersion,
            appliedTxPruneMaxRows: options.appliedTxPruneMaxRows ?? 1000,
            appliedTxPruneMaxAgeSeconds: options.appliedTxPruneMaxAgeSeconds ?? 86400,
            pullSinceReloadThreshold: options.pullSinceReloadThreshold ?? 128,
        })) {
            if (!Number.isSafeInteger(value) || value < (name === "schemaVersion" ? 1 : 0)) {
                throw new Error(
                    `IndexedDB ${name} must be a ${name === "schemaVersion" ? "positive" : "non-negative"} safe integer.`
                );
            }
        }
    }

    private async collectionDatabase(collectionId: string): Promise<IDBPDatabase<IndexedDBPersistenceDB>> {
        const database = await this.database();
        let initialized = this.initialized.get(collectionId);
        if (!initialized) {
            initialized = this.initializeCollection(database, collectionId);
            this.initialized.set(collectionId, initialized);
            void initialized.catch(() => this.initialized.delete(collectionId));
        }
        await initialized;
        return database;
    }

    private async initializeCollection(
        database: IDBPDatabase<IndexedDBPersistenceDB>,
        collectionId: string
    ): Promise<number> {
        const transaction = database.transaction(
            [ROWS, TRANSACTIONS, COLLECTION_METADATA, STREAMS, INDEX_DEFINITIONS, INDEX_ENTRIES],
            "readwrite"
        );
        try {
            let stream = await transaction.objectStore(STREAMS).get(collectionId);
            // Existing version-1 databases were written with the default collection schema (1).
            const storedVersion = stream?.schemaVersion ?? (stream ? 1 : this.schemaVersion);
            if (storedVersion > this.schemaVersion)
                throw new Error(
                    `Collection "${collectionId}" has schema ${storedVersion}; refusing to downgrade to ${this.schemaVersion}.`
                );
            if (storedVersion !== this.schemaVersion) {
                if (this.options.schemaMismatchPolicy === "sync-absent-error") {
                    throw new Error(
                        `Schema version mismatch for collection "${collectionId}": found ${storedVersion}, expected ${this.schemaVersion}. Local-only data was preserved.`
                    );
                }
                for (const name of [
                    ROWS,
                    TRANSACTIONS,
                    COLLECTION_METADATA,
                    INDEX_DEFINITIONS,
                    INDEX_ENTRIES,
                ] as const) {
                    const store = transaction.objectStore(name);
                    const keys = await store.index(BY_COLLECTION).getAllKeys(collectionId);
                    await Promise.all(keys.map((key) => store.delete(key as never)));
                }
                stream = {
                    collectionId,
                    latestTerm: 0,
                    latestSeq: 0,
                    latestRowVersion: (stream?.latestRowVersion ?? 0) + 1,
                    resetEpoch: (stream?.resetEpoch ?? 0) + 1,
                    replayFloor: (stream?.latestRowVersion ?? 0) + 1,
                };
            }
            const result = {
                collectionId,
                latestTerm: 0,
                latestSeq: 0,
                latestRowVersion: 0,
                ...stream,
                schemaVersion: this.schemaVersion,
            };
            const log = transaction.objectStore(TRANSACTIONS);
            const versionRange = IDBKeyRange.bound(
                [collectionId, 0],
                [collectionId, Number.MAX_SAFE_INTEGER]
            );
            let count = await log.index(BY_COLLECTION).count(collectionId);
            if ((await log.index(BY_VERSION).count(versionRange)) !== count) {
                let legacy = await log.index(BY_COLLECTION).openCursor(collectionId);
                while (legacy) {
                    if (legacy.value.rowVersion === undefined)
                        await legacy.update({
                            ...legacy.value,
                            rowVersion: result.latestRowVersion,
                            appliedAt: Date.now(),
                            delta: null,
                        });
                    legacy = await legacy.continue();
                }
            }
            const cutoff = Date.now() - (this.options.appliedTxPruneMaxAgeSeconds ?? 86400) * 1000;
            let oldest = await log
                .index(BY_VERSION)
                .openCursor(IDBKeyRange.bound([collectionId, 0], [collectionId, Number.MAX_SAFE_INTEGER]));
            while (oldest) {
                if (
                    count <= (this.options.appliedTxPruneMaxRows ?? 1000) &&
                    (oldest.value.appliedAt ?? 0) >= cutoff
                )
                    break;
                result.replayFloor = Math.max(result.replayFloor ?? 0, oldest.value.rowVersion ?? 0);
                await oldest.delete();
                count--;
                oldest = await oldest.continue();
            }
            await transaction.objectStore(STREAMS).put(result);
            await transaction.done;
            return result.resetEpoch ?? 0;
        } catch (error) {
            try {
                transaction.abort();
            } catch {
                /* Already aborted. */
            }
            await transaction.done.catch(() => undefined);
            throw error;
        }
    }

    private async assertSchema(stream: StreamRecord | undefined, collectionId: string): Promise<void> {
        const epoch = await this.initialized.get(collectionId);
        if (stream?.schemaVersion !== this.schemaVersion || (stream.resetEpoch ?? 0) !== epoch) {
            throw new Error(
                `Collection "${collectionId}" was reset or migrated by another adapter. Refusing access through a stale IndexedDB adapter.`
            );
        }
    }

    async loadResumeSnapshot(
        collectionId: string,
        context?: { requiredIndexSignatures?: ReadonlyArray<string>; includeRows?: boolean }
    ): ReturnType<PersistenceAdapter["loadResumeSnapshot"]> {
        const database = await this.collectionDatabase(collectionId);
        // Read data and its cursor together so a concurrent commit cannot make
        // the resume position newer than the rows restored from this snapshot.
        const transaction = database.transaction([ROWS, COLLECTION_METADATA, STREAMS], "readonly");
        const [rows, metadata, stream] = await Promise.all([
            context?.includeRows === false
                ? Promise.resolve([])
                : transaction.objectStore(ROWS).index(BY_COLLECTION).getAll(collectionId),
            transaction.objectStore(COLLECTION_METADATA).index(BY_COLLECTION).getAll(collectionId),
            transaction.objectStore(STREAMS).get(collectionId),
        ]);
        await this.assertSchema(stream, collectionId);
        await transaction.done;
        return {
            rows: rows.map(({ key, value, metadata }) => ({
                key,
                value: decodePersistedValue(value) as Record<string, unknown>,
                metadata: decodePersistedValue(metadata),
            })),
            collectionMetadata: metadata.map(({ key, value }) => ({
                key,
                value: decodePersistedValue(value),
            })),
            latestTerm: stream?.latestTerm ?? 0,
            latestSeq: stream?.latestSeq ?? 0,
            latestRowVersion: stream?.latestRowVersion ?? 0,
            resetEpoch: stream?.resetEpoch ?? 0,
        };
    }

    async loadSubset(collectionId: string, options: LoadSubsetOptions): Promise<PersistedRow[]> {
        if (options.cursor) {
            const combine = (predicate: IR.BasicExpression<boolean>) =>
                options.where ? new IR.Func<boolean>("and", [options.where, predicate]) : predicate;
            // Restore every row tied at the current boundary, then the requested following page.
            const [current, following] = await Promise.all([
                this.loadSubset(collectionId, {
                    where: combine(options.cursor.whereCurrent),
                    orderBy: options.orderBy,
                }),
                this.loadSubset(collectionId, {
                    where: combine(options.cursor.whereFrom),
                    orderBy: options.orderBy,
                    limit: options.limit,
                }),
            ]);
            const currentPredicate = compileSingleRowExpression(combine(options.cursor.whereCurrent));
            const merged = new Map(
                [...current.filter((row) => currentPredicate(row.value) === true), ...following].map(
                    (row) => [encodePersistedStorageKey(row.key), row]
                )
            );
            return orderRows([...merged.values()], options.orderBy).rows;
        }
        const database = await this.collectionDatabase(collectionId);
        const transaction = database.transaction(
            [ROWS, INDEX_DEFINITIONS, INDEX_ENTRIES, STREAMS],
            "readonly"
        );
        await this.assertSchema(await transaction.objectStore(STREAMS).get(collectionId), collectionId);
        const definitions = await transaction
            .objectStore(INDEX_DEFINITIONS)
            .index(BY_COLLECTION)
            .getAll(collectionId);
        // Older Temporal encodings can omit valid range candidates. Ignore
        // those indexes until ensureIndex or a write rebuilds them.
        const plan = selectIndexPlan(
            definitions.filter((definition) => definition.encodingVersion === INDEX_ENCODING_VERSION),
            options
        );

        const orderedClause = options.orderBy?.length === 1 ? options.orderBy[0] : undefined;
        const orderedDefinition =
            orderedClause &&
            definitions.find((definition) => {
                const types = definition.valueTypes.filter((type) => type !== "string-ci");
                return (
                    definition.encodingVersion === INDEX_ENCODING_VERSION &&
                    !definition.hasUnsupportedValues &&
                    types.length === 1 &&
                    [
                        "number",
                        "boolean",
                        "date",
                        "temporal-instant",
                        "temporal-plain-date",
                        ...(orderedClause.compareOptions.stringSort === "lexical" ? ["string"] : []),
                    ].includes(types[0]!) &&
                    expressionsMatch(definition.expression, orderedClause.expression)
                );
            });
        if (orderedDefinition && orderedClause) {
            const type = orderedDefinition.valueTypes.find((type) => type !== "string-ci")!;
            const findOrderedRange = (candidate: IndexPlan | undefined): IDBKeyRange | undefined => {
                if (
                    candidate?.kind === "lookup" &&
                    candidate.definition?.signature === orderedDefinition.signature &&
                    candidate.ranges?.length === 1
                )
                    return candidate.ranges[0];
                if (candidate?.kind === "and") {
                    for (const child of candidate.children ?? []) {
                        const range = findOrderedRange(child);
                        if (range) return range;
                    }
                }
                return undefined;
            };
            const range =
                findOrderedRange(plan) ??
                IDBKeyRange.bound(
                    [collectionId, orderedDefinition.signature, type],
                    [collectionId, orderedDefinition.signature, type, []]
                );
            const predicate = options.where ? compileSingleRowExpression(options.where) : undefined;
            const limit = options.limit === undefined ? Infinity : Math.max(0, Math.trunc(options.limit));
            const offset = Math.max(0, Math.trunc(options.offset ?? 0));
            const needed = plan?.kind === "none" ? 0 : limit + offset;
            const selected: PersistedRow[] = [];
            let group: PersistedRow[] = [];
            let groupValue: IndexValue | undefined;
            const flush = () => {
                group.sort(compareKeys);
                selected.push(...group);
                group = [];
            };
            let cursor =
                needed === 0
                    ? null
                    : await transaction
                          .objectStore(INDEX_ENTRIES)
                          .index(BY_LOOKUP)
                          .openCursor(
                              range,
                              orderedClause.compareOptions.direction === "desc" ? "prev" : "next"
                          );
            while (cursor) {
                const entry = cursor.value;
                if (groupValue !== undefined && indexedDB.cmp(groupValue, entry.value) !== 0) {
                    flush();
                    if (selected.length >= needed) break;
                }
                groupValue = entry.value;
                const stored = await transaction.objectStore(ROWS).get(entry.rowId);
                if (stored) {
                    const row = decodeRow(stored);
                    if (!predicate || predicate(row.value) === true) group.push(row);
                }
                cursor = await cursor.continue();
            }
            flush();
            await transaction.done;
            return selected.slice(offset, offset + limit);
        }

        let rows: RowRecord[];
        if (plan) {
            const lookup = transaction.objectStore(INDEX_ENTRIES).index(BY_LOOKUP);

            async function estimatePlan(current: IndexPlan): Promise<number> {
                if (current.kind === "none") return 0;
                if (current.kind === "lookup") {
                    const counts = await Promise.all(
                        (current.ranges ?? []).map((range) => lookup.count(range))
                    );
                    return counts.reduce((total, count) => total + count, 0);
                }
                const estimates = await Promise.all((current.children ?? []).map(estimatePlan));
                return current.kind === "and"
                    ? Math.min(...estimates)
                    : estimates.reduce((total, count) => total + count, 0);
            }

            async function iteratePlan(current: IndexPlan, visit: (rowId: string) => void): Promise<void> {
                if (current.kind === "none") return;
                if (current.kind === "lookup") {
                    for (const range of current.ranges ?? []) {
                        let remaining: IDBKeyRange | undefined = range;
                        while (remaining) {
                            const entries = await lookup.getAll(remaining, INDEX_BATCH_SIZE);
                            for (const entry of entries) {
                                visit(entry.rowId);
                            }
                            if (entries.length < INDEX_BATCH_SIZE) break;
                            remaining = rangeAfter(range, entries.at(-1)!);
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

            async function executePlan(current: IndexPlan): Promise<Set<string>> {
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
            const keys = [...rowIds];
            for (let offset = 0; offset < keys.length; offset += INDEX_BATCH_SIZE) {
                const loaded = await Promise.all(
                    keys.slice(offset, offset + INDEX_BATCH_SIZE).map((key) => rowStore.get(key))
                );
                rows.push(...loaded.filter((row): row is RowRecord => row !== undefined));
            }
        } else {
            rows = await transaction.objectStore(ROWS).index(BY_COLLECTION).getAll(collectionId);
        }
        await transaction.done;
        const decoded = rows.map(decodeRow);
        if (!options.orderBy?.length && options.limit === undefined && options.offset === undefined)
            return decoded;
        const predicate = options.where ? compileSingleRowExpression(options.where) : undefined;
        const filtered = predicate ? decoded.filter((row) => predicate(row.value) === true) : decoded;
        const ordered = orderRows(filtered, options.orderBy);
        if (!ordered.supported) return ordered.rows;
        const offset = Math.max(0, Math.trunc(options.offset ?? 0));
        const limit = options.limit === undefined ? Infinity : Math.max(0, Math.trunc(options.limit));
        return ordered.rows.slice(offset, offset + limit);
    }

    async applyCommittedTx(collectionId: string, committed: PersistedTx): Promise<void> {
        const database = await this.collectionDatabase(collectionId);
        const transaction = database.transaction(
            [ROWS, TRANSACTIONS, COLLECTION_METADATA, STREAMS, INDEX_DEFINITIONS, INDEX_ENTRIES],
            "readwrite"
        );
        try {
            await this.assertSchema(await transaction.objectStore(STREAMS).get(collectionId), collectionId);
            const transactionId = id(collectionId, committed.txId);
            const previous = await transaction.objectStore(TRANSACTIONS).get(transactionId);
            if (previous) {
                await transaction.done;
                return;
            }
            const [stream, definitions] = await Promise.all([
                transaction.objectStore(STREAMS).get(collectionId),
                transaction.objectStore(INDEX_DEFINITIONS).index(BY_COLLECTION).getAll(collectionId),
            ]);
            const rowStore = transaction.objectStore(ROWS);
            const changedKeys = new Set(committed.mutations.map((mutation) => mutation.key));
            const touchedKeys = new Set([
                ...changedKeys,
                ...(committed.rowMetadataMutations ?? []).map((mutation) => mutation.key),
            ]);
            const previousRows = new Map<string, RowRecord>();
            if (committed.truncate) {
                const keys = await rowStore.index(BY_COLLECTION).getAllKeys(collectionId);
                await Promise.all(keys.map((key) => rowStore.delete(key)));
            } else {
                await Promise.all(
                    [...touchedKeys].map(async (key) => {
                        const row = await rowStore.get(rowId(collectionId, key));
                        if (row)
                            previousRows.set(row.id, {
                                ...row,
                                value: decodePersistedValue(row.value) as Record<string, unknown>,
                                metadata: decodePersistedValue(row.metadata),
                            });
                    })
                );
            }
            const rows = new Map(previousRows);
            for (const mutation of committed.mutations) {
                const key = rowId(collectionId, mutation.key);
                if (mutation.type === "delete") {
                    rows.delete(key);
                } else {
                    const existing = rows.get(key);
                    rows.set(key, {
                        id: key,
                        collectionId,
                        key: mutation.key,
                        value:
                            mutation.type === "update"
                                ? { ...existing?.value, ...mutation.value }
                                : mutation.value,
                        metadata: mutation.metadataChanged === true ? mutation.metadata : existing?.metadata,
                    });
                }
            }
            for (const mutation of committed.rowMetadataMutations ?? []) {
                const key = rowId(collectionId, mutation.key);
                const existing = rows.get(key);
                if (!existing) continue;
                rows.set(key, {
                    ...existing,
                    metadata: mutation.type === "delete" ? undefined : mutation.value,
                });
            }
            await Promise.all(
                [...touchedKeys].map((key) => {
                    const row = rows.get(rowId(collectionId, key));
                    return row
                        ? rowStore.put({
                              ...row,
                              hasMetadata: row.metadata === undefined ? 0 : 1,
                              value: encodePersistedValue(row.value) as Record<string, unknown>,
                              metadata: encodePersistedValue(row.metadata),
                          })
                        : rowStore.delete(rowId(collectionId, key));
                })
            );
            const metadataStore = transaction.objectStore(COLLECTION_METADATA);
            for (const mutation of committed.collectionMetadataMutations ?? []) {
                const key = id(collectionId, mutation.key);
                if (mutation.type === "delete") await metadataStore.delete(key);
                else
                    await metadataStore.put({
                        id: key,
                        collectionId,
                        key: mutation.key,
                        value: encodePersistedValue(mutation.value),
                    });
            }

            const indexEntryStore = transaction.objectStore(INDEX_ENTRIES);
            if (committed.truncate) {
                const keys = await indexEntryStore.index(BY_COLLECTION).getAllKeys(collectionId);
                await Promise.all(keys.map((key) => indexEntryStore.delete(key)));
            }
            const definitionStore = transaction.objectStore(INDEX_DEFINITIONS);
            for (const definition of definitions) {
                if (!committed.truncate && changedKeys.size === 0) continue;
                const changedPrevious = [...previousRows.values()].filter((row) => changedKeys.has(row.key));
                const changedNext = [...rows.values()].filter((row) => changedKeys.has(row.key));
                const before = buildIndexRecords(definition, changedPrevious);
                const after = buildIndexRecords(definition, changedNext);
                if (committed.truncate) {
                    await definitionStore.put(after.definition);
                    await Promise.all(after.entries.map((entry) => indexEntryStore.put(entry)));
                } else if (
                    definition.valueTypeCounts &&
                    definition.unsupportedValueCount !== undefined &&
                    definition.encodingVersion === INDEX_ENCODING_VERSION
                ) {
                    const counts = { ...definition.valueTypeCounts };
                    for (const type of new Set([
                        ...before.definition.valueTypes,
                        ...after.definition.valueTypes,
                    ])) {
                        const count =
                            (counts[type] ?? 0) -
                            (before.definition.valueTypeCounts?.[type] ?? 0) +
                            (after.definition.valueTypeCounts?.[type] ?? 0);
                        if (count === 0) delete counts[type];
                        else counts[type] = count;
                    }
                    const unsupportedValueCount =
                        definition.unsupportedValueCount -
                        (before.definition.unsupportedValueCount ?? 0) +
                        (after.definition.unsupportedValueCount ?? 0);
                    await Promise.all(
                        before.entries.map((entry) =>
                            indexEntryStore.delete([
                                collectionId,
                                definition.signature,
                                entry.valueType,
                                entry.rowId,
                            ])
                        )
                    );
                    await Promise.all(after.entries.map((entry) => indexEntryStore.put(entry)));
                    await definitionStore.put({
                        ...definition,
                        valueTypeCounts: counts,
                        unsupportedValueCount,
                        valueTypes: Object.keys(counts) as IndexValueType[],
                        hasUnsupportedValues: unsupportedValueCount > 0,
                    });
                } else {
                    // Upgrade legacy index summaries once, then maintain only changed rows.
                    const storedRows = await rowStore.index(BY_COLLECTION).getAll(collectionId);
                    const built = buildIndexRecords(
                        definition,
                        storedRows.map((row) => ({
                            ...row,
                            value: decodePersistedValue(row.value) as Record<string, unknown>,
                        }))
                    );
                    const keys = await indexEntryStore
                        .index(BY_INDEX)
                        .getAllKeys([collectionId, definition.signature]);
                    await Promise.all(keys.map((key) => indexEntryStore.delete(key)));
                    await definitionStore.put(built.definition);
                    await Promise.all(built.entries.map((entry) => indexEntryStore.put(entry)));
                }
            }
            const nextRowVersion = Math.max((stream?.latestRowVersion ?? 0) + 1, committed.rowVersion);
            const delta: ReplayableTxDelta | null = committed.truncate
                ? null
                : {
                      txId: committed.txId,
                      latestRowVersion: nextRowVersion,
                      changedRows: [...rows.values()]
                          .filter((row) => changedKeys.has(row.key))
                          .map(({ key, value }) => ({ key, value })),
                      deletedKeys: [...changedKeys].filter((key) => !rows.has(rowId(collectionId, key))),
                      rowMetadataMutations: [...touchedKeys]
                          .filter((key) => {
                              const row = rows.get(rowId(collectionId, key));
                              return row && row.metadata !== previousRows.get(row.id)?.metadata;
                          })
                          .map((key) => {
                              const metadata = rows.get(rowId(collectionId, key))!.metadata;
                              return metadata === undefined
                                  ? { type: "delete" as const, key }
                                  : { type: "set" as const, key, value: metadata };
                          }),
                      collectionMetadataMutations: committed.collectionMetadataMutations ?? [],
                  };
            const log = transaction.objectStore(TRANSACTIONS);
            await log.put({
                id: transactionId,
                collectionId,
                rowVersion: nextRowVersion,
                appliedAt: Date.now(),
                delta: encodePersistedValue(delta) as ReplayableTxDelta | null,
            });
            let replayFloor = stream?.replayFloor ?? 0;
            let count = await log.index(BY_COLLECTION).count(collectionId);
            const maxRows = this.options.appliedTxPruneMaxRows ?? 1000;
            const cutoff = Date.now() - (this.options.appliedTxPruneMaxAgeSeconds ?? 86400) * 1000;
            const range = IDBKeyRange.bound([collectionId, 0], [collectionId, Number.MAX_SAFE_INTEGER]);
            let cursor = await log.index(BY_VERSION).openCursor(range);
            while (cursor) {
                const record = cursor.value;
                if (count <= maxRows && (record.appliedAt ?? 0) >= cutoff) break;
                await cursor.delete();
                replayFloor = Math.max(replayFloor, record.rowVersion ?? 0);
                count--;
                cursor = await cursor.continue();
            }
            await transaction.objectStore(STREAMS).put({
                ...stream,
                collectionId,
                latestTerm: Math.max(stream?.latestTerm ?? 0, committed.term),
                latestSeq:
                    committed.term > (stream?.latestTerm ?? 0)
                        ? committed.seq
                        : committed.term === (stream?.latestTerm ?? 0)
                          ? Math.max(stream?.latestSeq ?? 0, committed.seq)
                          : (stream?.latestSeq ?? 0),
                latestRowVersion: nextRowVersion,
                replayFloor,
            });
            await transaction.done;
        } catch (error) {
            try {
                transaction.abort();
            } catch {
                /* The request may already have aborted it. */
            }
            await transaction.done.catch(() => undefined);
            throw error;
        }
    }

    async loadCollectionMetadata(collectionId: string): Promise<Array<{ key: string; value: unknown }>> {
        const database = await this.collectionDatabase(collectionId);
        const transaction = database.transaction([COLLECTION_METADATA, STREAMS], "readonly");
        await this.assertSchema(await transaction.objectStore(STREAMS).get(collectionId), collectionId);
        const records = await transaction
            .objectStore(COLLECTION_METADATA)
            .index(BY_COLLECTION)
            .getAll(collectionId);
        await transaction.done;
        return records.map(({ key, value }) => ({
            key,
            value: decodePersistedValue(value),
        }));
    }

    async scanRows(collectionId: string, options?: PersistedRowScanOptions): Promise<PersistedRow[]> {
        if (!options?.metadataOnly) return this.loadSubset(collectionId, {});
        const database = await this.collectionDatabase(collectionId);
        const transaction = database.transaction([ROWS, STREAMS], "readonly");
        await this.assertSchema(await transaction.objectStore(STREAMS).get(collectionId), collectionId);
        const rows = await transaction.objectStore(ROWS).index(BY_METADATA).getAll([collectionId, 1]);
        await transaction.done;
        return rows.map(({ key, value, metadata }) => ({
            key,
            value: decodePersistedValue(value) as Record<string, unknown>,
            metadata: decodePersistedValue(metadata),
        }));
    }

    async pullSince(
        collectionId: string,
        fromRowVersion: number
    ): Promise<PersistencePullSinceResult & { latestTerm: number; latestSeq: number }> {
        const database = await this.collectionDatabase(collectionId);
        const transaction = database.transaction([TRANSACTIONS, STREAMS], "readonly");
        const stream = await transaction.objectStore(STREAMS).get(collectionId);
        await this.assertSchema(stream, collectionId);
        const latestRowVersion = stream!.latestRowVersion;
        const generation = { latestRowVersion, latestTerm: stream!.latestTerm, latestSeq: stream!.latestSeq };
        const reload = { ...generation, requiresFullReload: true as const };
        if (
            !Number.isSafeInteger(fromRowVersion) ||
            fromRowVersion < (stream!.replayFloor ?? 0) ||
            fromRowVersion > latestRowVersion
        ) {
            await transaction.done;
            return reload;
        }
        if (fromRowVersion === latestRowVersion) {
            await transaction.done;
            return { ...generation, requiresFullReload: false, changedKeys: [], deletedKeys: [], deltas: [] };
        }
        const records = await transaction
            .objectStore(TRANSACTIONS)
            .index(BY_VERSION)
            .getAll(
                IDBKeyRange.bound([collectionId, fromRowVersion], [collectionId, latestRowVersion], true)
            );
        await transaction.done;
        let expectedVersion = fromRowVersion + 1;
        const deltas: ReplayableTxDelta[] = [];
        let changeCount = 0;
        for (const record of records) {
            if (record.rowVersion !== expectedVersion++ || !record.delta) return reload;
            const delta = decodePersistedValue(record.delta) as ReplayableTxDelta;
            changeCount +=
                delta.changedRows.length +
                delta.deletedKeys.length +
                delta.rowMetadataMutations.length +
                delta.collectionMetadataMutations.length;
            if (changeCount > (this.options.pullSinceReloadThreshold ?? 128)) return reload;
            deltas.push(delta);
        }
        if (expectedVersion - 1 !== latestRowVersion) return reload;
        const changed = new Set<string | number>();
        const deleted = new Set<string | number>();
        for (const delta of deltas) {
            for (const { key } of delta.changedRows) {
                changed.add(key);
                deleted.delete(key);
            }
            for (const mutation of delta.rowMetadataMutations)
                if (!deleted.has(mutation.key)) changed.add(mutation.key);
            for (const key of delta.deletedKeys) {
                deleted.add(key);
                changed.delete(key);
            }
        }
        return {
            ...generation,
            requiresFullReload: false,
            changedKeys: [...changed],
            deletedKeys: [...deleted],
            deltas,
        };
    }

    async ensureIndex(collectionId: string, signature: string, spec: PersistedIndexSpec): Promise<void> {
        const database = await this.collectionDatabase(collectionId);
        const expression = parseIndexExpression(spec);
        const transaction = database.transaction(
            [ROWS, INDEX_DEFINITIONS, INDEX_ENTRIES, STREAMS],
            "readwrite"
        );
        try {
            await this.assertSchema(await transaction.objectStore(STREAMS).get(collectionId), collectionId);
            const existing = await transaction.objectStore(INDEX_DEFINITIONS).get([collectionId, signature]);
            if (
                existing &&
                JSON.stringify(existing.expression) === JSON.stringify(expression) &&
                existing.valueTypeCounts &&
                existing.unsupportedValueCount !== undefined &&
                existing.encodingVersion === INDEX_ENCODING_VERSION
            ) {
                await transaction.done;
                return;
            }
            const rows = await transaction.objectStore(ROWS).index(BY_COLLECTION).getAll(collectionId);
            const built = buildIndexRecords(
                {
                    collectionId,
                    signature,
                    expression,
                },
                rows.map((row) => ({
                    ...row,
                    value: decodePersistedValue(row.value) as Record<string, unknown>,
                    metadata: decodePersistedValue(row.metadata),
                }))
            );
            const entryStore = transaction.objectStore(INDEX_ENTRIES);
            const existingKeys = await entryStore.index(BY_INDEX).getAllKeys([collectionId, signature]);
            await Promise.all(existingKeys.map((key) => entryStore.delete(key)));
            await Promise.all(built.entries.map((entry) => entryStore.put(entry)));
            await transaction.objectStore(INDEX_DEFINITIONS).put(built.definition);
            await transaction.done;
        } catch (error) {
            try {
                transaction.abort();
            } catch {
                /* The request may already have aborted it. */
            }
            await transaction.done.catch(() => undefined);
            throw error;
        }
    }

    async markIndexRemoved(collectionId: string, signature: string): Promise<void> {
        const database = await this.collectionDatabase(collectionId);
        const transaction = database.transaction([INDEX_DEFINITIONS, INDEX_ENTRIES, STREAMS], "readwrite");
        await this.assertSchema(await transaction.objectStore(STREAMS).get(collectionId), collectionId);
        await transaction.objectStore(INDEX_DEFINITIONS).delete([collectionId, signature]);
        const entryStore = transaction.objectStore(INDEX_ENTRIES);
        const keys = await entryStore.index(BY_INDEX).getAllKeys([collectionId, signature]);
        await Promise.all(keys.map((key) => entryStore.delete(key)));
        await transaction.done;
    }

    async getStreamPosition(collectionId: string): Promise<StreamRecord> {
        const database = await this.collectionDatabase(collectionId);
        const stream = await database.get(STREAMS, collectionId);
        await this.assertSchema(stream, collectionId);
        return (
            stream ?? {
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

    private database(): Promise<IDBPDatabase<IndexedDBPersistenceDB>> {
        if (this.closed) {
            return Promise.reject(new Error("IndexedDB persistence adapter is closed."));
        }
        this.databasePromise ??= openDB<IndexedDBPersistenceDB>(this.options.databaseName, DATABASE_VERSION, {
            upgrade(database, oldVersion, _newVersion, transaction) {
                if (oldVersion < 1) {
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
                        keyPath: ["collectionId", "signature", "valueType", "rowId"],
                    });
                    entries.createIndex(BY_COLLECTION, "collectionId");
                    entries.createIndex(BY_INDEX, ["collectionId", "signature"]);
                    entries.createIndex(BY_LOOKUP, [
                        "collectionId",
                        "signature",
                        "valueType",
                        "value",
                        "rowId",
                    ]);
                }
                if (oldVersion < 2) {
                    const rows = transaction.objectStore(ROWS);
                    rows.createIndex(BY_METADATA, ["collectionId", "hasMetadata"]);
                    transaction
                        .objectStore(TRANSACTIONS)
                        .createIndex(BY_VERSION, ["collectionId", "rowVersion"]);
                    // Populate the selective metadata index for existing v1 databases.
                    void (async () => {
                        let cursor = await rows.openCursor();
                        while (cursor) {
                            await cursor.update({
                                ...cursor.value,
                                hasMetadata: cursor.value.metadata === undefined ? 0 : 1,
                            });
                            cursor = await cursor.continue();
                        }
                    })().catch(() => transaction.abort());
                }
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
