import { ObjectTypeIcon } from "./OntologyIcons.js";
import type { Demand } from "./diagnostics.js";
import type { ObjectTypeDef } from "@party-stack/ontology";

type Query = NonNullable<Demand["query"]>;
type Predicate = NonNullable<Query["where"]>;
export type QueryOperand = Extract<Predicate, { left: unknown }>["left"];

export function operandText(value: unknown, object?: ObjectTypeDef): string {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "object" && "_tag" in value && value._tag === "Field" && "path" in value)
        return (value.path as string[])
            .map((part, index) =>
                index === 0
                    ? (object?.properties.find((property) => property.name === part)?.displayName ?? part)
                    : part
            )
            .join(".");
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "bigint") return `${value}n`;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value === "symbol") return value.toString();
    if (typeof value === "function") return "[Function]";
    return JSON.stringify(value);
}

export function nullOrderLabel(order: { direction?: string; nulls?: string }): string {
    const defaultNulls = order.direction === "desc" ? "last" : "first";
    return order.nulls && order.nulls !== defaultNulls ? ` · nulls ${order.nulls}` : "";
}

export function OperandToken({
    value,
    object,
    pattern = false,
}: {
    value: unknown;
    object?: ObjectTypeDef;
    pattern?: boolean;
}) {
    const field = typeof value === "object" && value !== null && "_tag" in value && value._tag === "Field";
    const special = value === null || value === undefined;
    return (
        <span
            className={field ? "ps-query-field" : special ? "ps-query-special" : "ps-query-literal"}
            title={
                field
                    ? `Field: ${operandText(value)}`
                    : value === undefined
                      ? "Missing field or JavaScript undefined; distinct from null"
                      : value === null
                        ? "Explicit null value; distinct from an undefined field"
                        : undefined
            }
        >
            {pattern && typeof value === "string" ? (
                <>
                    &quot;
                    {value.split(/([%_])/u).map((part, index) =>
                        part === "%" || part === "_" ? (
                            <span
                                className="ps-query-wildcard"
                                title={part === "%" ? "Any sequence of characters" : "One character"}
                                key={index}
                            >
                                {part}
                            </span>
                        ) : (
                            <span key={index}>{JSON.stringify(part).slice(1, -1)}</span>
                        )
                    )}
                    &quot;
                </>
            ) : (
                operandText(value, object)
            )}
        </span>
    );
}

export function QuerySubject({ object, objectType }: { object?: ObjectTypeDef; objectType?: string }) {
    if (!object && !objectType) return null;
    return (
        <span className="ps-query-subject">
            {object && <ObjectTypeIcon className="ps-query-object-icon" objectType={object} />}
            <strong>{object?.pluralDisplayName ?? objectType}</strong>
        </span>
    );
}
