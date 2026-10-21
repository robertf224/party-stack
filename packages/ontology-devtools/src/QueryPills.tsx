import { ObjectTypeIcon } from "./OntologyIcons.js";
import type { Demand, Load } from "./diagnostics.js";
import type { ObjectTypeDef } from "@party-stack/ontology";

type Query = NonNullable<Demand["query"]>;
type Predicate = NonNullable<Query["where"]>;
type Operand = Extract<Predicate, { left: unknown }>["left"];
type Annotations = NonNullable<Load["pushdown"]>["predicates"];
const operators = {
    eq: "=",
    ne: "≠",
    lt: "<",
    lte: "≤",
    gt: ">",
    gte: "≥",
    like: "matches",
    ilike: "matches (ignore case)",
    contains: "contains",
};
export function operandText(value: Operand, object?: ObjectTypeDef): string {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "object" && "_tag" in value && value._tag === "Field") {
        return value.path
            .map((part, index) =>
                index === 0
                    ? (object?.properties.find((property) => property.name === part)?.displayName ?? part)
                    : part
            )
            .join(".");
    }
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "bigint") return `${value}n`;
    if (value instanceof Date) return value.toISOString();
    return typeof value === "object" ? JSON.stringify(value) : String(value);
}
export function predicateText(predicate: Predicate, object?: ObjectTypeDef): string {
    if (predicate.op === "and" || predicate.op === "or")
        return predicate.predicates.length
            ? `(${predicate.predicates.map((item) => predicateText(item, object)).join(predicate.op === "and" ? " AND " : " OR ")})`
            : predicate.op === "and"
              ? "All rows"
              : "No rows";
    if (predicate.op === "not") return `NOT (${predicateText(predicate.predicate, object)})`;
    if (predicate.op === "in")
        return `${operandText(predicate.left, object)} in [${predicate.values.map((value) => operandText(value)).join(", ")}]`;
    if (
        (predicate.op === "eq" || predicate.op === "ne") &&
        (predicate.right === null || predicate.right === undefined)
    )
        return `${operandText(predicate.left, object)} is${predicate.op === "ne" ? " not" : ""} ${operandText(predicate.right)}`;
    return `${operandText(predicate.left, object)} ${operators[predicate.op]} ${operandText(predicate.right, object)}`;
}
export function nullOrderLabel(
    order: Pick<NonNullable<Query["orderBy"]>[number], "direction" | "nulls">
): string {
    const defaultNulls = order.direction === "desc" ? "last" : "first";
    return order.nulls && order.nulls !== defaultNulls ? ` · nulls ${order.nulls}` : "";
}
export function OperandToken({
    value,
    object,
    pattern = false,
}: {
    value: Operand;
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
// Adjacent identical boolean operators are associative; retain mixed AND/OR boundaries.
function booleanTerms(
    predicate: Extract<Predicate, { op: "and" | "or" }>,
    path: readonly number[]
): { predicate: Predicate; path: readonly number[] }[] {
    return predicate.predicates.flatMap<{ predicate: Predicate; path: readonly number[] }>((child, index) =>
        (child.op === "and" || child.op === "or") && child.op === predicate.op
            ? booleanTerms(child, [...path, index])
            : [{ predicate: child, path: [...path, index] }]
    );
}
function PredicatePills({
    predicate,
    object,
    annotations,
    path = [],
}: {
    predicate: Predicate;
    object?: ObjectTypeDef;
    annotations?: Annotations;
    path?: readonly number[];
}) {
    if (predicate.op === "and" || predicate.op === "or")
        return predicate.predicates.length ? (
            <div className="ps-query-group" aria-label={predicate.op.toUpperCase()}>
                <span className="ps-query-connector">{predicate.op.toUpperCase()}</span>
                <div className="ps-query-branches">
                    {booleanTerms(predicate, path).map((item, index) => (
                        <PredicatePills
                            key={index}
                            predicate={item.predicate}
                            path={item.path}
                            annotations={annotations}
                            object={object}
                        />
                    ))}
                </div>
            </div>
        ) : (
            <span className="ps-query-keyword">{predicate.op === "and" ? "All rows" : "No rows"}</span>
        );
    if (predicate.op === "not")
        return (
            <div className="ps-query-group" aria-label="NOT">
                <span className="ps-query-connector">NOT</span>
                <div className="ps-query-branches">
                    <PredicatePills
                        predicate={predicate.predicate}
                        path={[...path, 0]}
                        annotations={annotations}
                        object={object}
                    />
                </div>
            </div>
        );
    const nullish =
        (predicate.op === "eq" || predicate.op === "ne") &&
        (predicate.right === null || predicate.right === undefined);
    const execution = annotations?.find(
        (annotation) =>
            annotation.path.length === path.length &&
            annotation.path.every((part, index) => part === path[index])
    )?.execution;
    const labels = { source: "Pushed down", candidate: "Approximate pushdown", adapter: "Not pushed down" };
    const descriptions = {
        source: "Translated to a native source condition; the adapter may also verify returned rows.",
        candidate: "The source narrows candidates; the adapter evaluates the exact condition.",
        adapter: "Evaluated in the adapter; this condition was not sent to the source.",
    };
    return (
        <div className="ps-query-comparison" data-execution={execution}>
            <OperandToken value={predicate.left} object={object} />
            <span className="ps-query-operator">
                {predicate.op === "in"
                    ? "in"
                    : nullish
                      ? predicate.op === "ne"
                          ? "is not"
                          : "is"
                      : operators[predicate.op]}
            </span>
            {predicate.op === "in" ? (
                <span className="ps-query-values">
                    [{" "}
                    {predicate.values.map((value, index) => (
                        <OperandToken key={index} value={value} object={object} />
                    ))}{" "}
                    ]
                </span>
            ) : (
                <OperandToken
                    value={predicate.right}
                    object={object}
                    pattern={predicate.op === "like" || predicate.op === "ilike"}
                />
            )}
            {execution && (
                <span className="ps-query-execution-label" title={descriptions[execution]}>
                    {labels[execution]}
                </span>
            )}
        </div>
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
export function QueryPills({
    query,
    object,
    objectType,
    annotations,
}: {
    query?: Query;
    object?: ObjectTypeDef;
    objectType?: string;
    annotations?: Annotations;
}) {
    return (
        <div className="ps-query-expression">
            <div className="ps-query-sentence">
                <QuerySubject object={object} objectType={objectType} />
                {query?.where ? (
                    <>
                        <span className="ps-query-keyword">where</span>
                        <PredicatePills predicate={query.where} object={object} annotations={annotations} />
                    </>
                ) : (
                    <span className="ps-query-keyword">
                        {object || objectType ? "— all rows" : "All rows"}
                    </span>
                )}
            </div>
            {query?.orderBy?.map((order, index) => (
                <div className="ps-query-clause" key={index}>
                    <span className="ps-query-keyword">order by</span>
                    <OperandToken value={order.field} object={object} />
                    <span className="ps-query-operator">
                        {order.direction === "desc" ? "descending" : "ascending"}
                        {nullOrderLabel(order)}
                    </span>
                </div>
            ))}
            {query?.limit !== undefined && (
                <div className="ps-query-clause">
                    <span className="ps-query-keyword">limit</span>
                    <OperandToken value={query.limit} />
                </div>
            )}
            {query?.offset !== undefined && (
                <div className="ps-query-clause">
                    <span className="ps-query-keyword">offset</span>
                    <OperandToken value={query.offset} />
                </div>
            )}
            {query?.after && (
                <div className="ps-query-clause">
                    <span className="ps-query-keyword">after</span>
                    <OperandToken value={query.after.key} />
                    <span className="ps-query-values">
                        {query.after.values.map((value, index) => (
                            <OperandToken value={value} key={index} />
                        ))}
                    </span>
                </div>
            )}
        </div>
    );
}
