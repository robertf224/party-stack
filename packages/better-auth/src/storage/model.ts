import { o, type TypeDef } from "@party-stack/ontology-spec";
import { getAuthTables, getSchema } from "better-auth/db";
import { Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import type { BetterAuthOptions } from "better-auth";
import type { DBFieldAttribute } from "better-auth/db";

export type AuthRow = Record<string, unknown> & { id: string };
export type AuthSchema = ReturnType<typeof getSchema>;

export const fieldType = (attribute: DBFieldAttribute): TypeDef => {
    const type = attribute.type;
    if (Array.isArray(type))
        return o.string({
            constraint: o.StringConstraint.enum({ options: type.map((value) => ({ value, label: value })) }),
        });
    switch (type) {
        case "string":
            return o.string({});
        case "number":
            return o.double({});
        case "boolean":
            return o.boolean({});
        case "date":
            return o.timestamp({});
        case "json":
            return o.unknown({});
        case "string[]":
            return o.list({ elementType: o.string({}) });
        case "number[]":
            return o.list({ elementType: o.double({}) });
    }
};

/** Better Auth's expected view, including configured plugins and physical aliases. */
export function authStorageSchema(options: BetterAuthOptions): {
    schema: AuthSchema;
    logical: ReturnType<typeof getAuthTables>;
} {
    // getSchema rewrites reference metadata in place in Better Auth 1.7. Clone
    // authored plugin fields so one factory's aliases cannot mutate another's.
    const fields = (input: Record<string, DBFieldAttribute> | undefined) =>
        input &&
        Object.fromEntries(
            Object.entries(input).map(([name, attr]) => [
                name,
                { ...attr, references: attr.references && { ...attr.references } },
            ])
        );
    const copy = (): BetterAuthOptions => ({
        ...options,
        user: { ...options.user, additionalFields: fields(options.user?.additionalFields) },
        session: { ...options.session, additionalFields: fields(options.session?.additionalFields) },
        account: { ...options.account, additionalFields: fields(options.account?.additionalFields) },
        plugins: options.plugins?.map((plugin) => ({
            ...plugin,
            schema:
                plugin.schema &&
                Object.fromEntries(
                    Object.entries(plugin.schema).map(([name, table]) => [
                        name,
                        { ...table, fields: fields(table.fields)! },
                    ])
                ),
        })),
    });
    const logical = getAuthTables(copy());
    const schema = getSchema(copy());
    for (const table of Object.values(schema))
        for (const attribute of Object.values(table.fields)) {
            const reference = attribute.references;
            if (!reference) continue;
            const target = Object.values(logical).find((model) => model.modelName === reference.model);
            attribute.references = {
                ...reference,
                field: target?.fields[reference.field]?.fieldName ?? reference.field,
            };
        }
    return { schema, logical };
}

export function encodeAuthValue(attribute: DBFieldAttribute | undefined, value: unknown): unknown {
    if (value === null && attribute?.required === false) return undefined;
    if (attribute?.type === "date" && value instanceof Date)
        return Temporal.Instant.fromEpochMilliseconds(value.getTime());
    if (attribute?.type === "json" && value !== undefined)
        return Schema.decodeUnknownSync(Schema.Json)(value);
    return value;
}

export function decodeAuthRow(schema: AuthSchema, model: string, row: AuthRow): AuthRow {
    return Object.fromEntries(
        Object.entries(row).map(([name, value]) => [
            name,
            schema[model]?.fields[name]?.type === "date" && value instanceof Temporal.Instant
                ? new Date(value.epochMilliseconds)
                : value,
        ])
    ) as AuthRow;
}
