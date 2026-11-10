import { Fragment } from "react";
import { DisclosureSummary } from "./DisclosureSummary.js";
import { OperandToken, QuerySubject, nullOrderLabel } from "./QueryTokens.js";
import { typeDisplayName } from "./typeDisplayName.js";
import type { Load } from "./diagnostics.js";
import type {
    Expression,
    ObjectTypeDef,
    OntologyIR,
    Query,
    QueryDocument,
    QuerySelection,
} from "@party-stack/ontology";

type Scope = Readonly<Record<string, ObjectTypeDef | undefined>>;
type Annotations = NonNullable<Load["pushdown"]>["predicates"];
interface ExpressionProps {
    expression: Expression;
    scope?: Scope;
    ir?: OntologyIR;
    compactBinding?: string;
    annotations?: Annotations;
    path?: readonly number[];
    pattern?: boolean;
}
const operators = {
    eq: "=",
    ne: "≠",
    lt: "<",
    lte: "≤",
    gt: ">",
    gte: "≥",
    in: "in",
    contains: "contains",
    like: "matches",
    ilike: "matches (ignore case)",
    add: "+",
    subtract: "−",
    multiply: "×",
    divide: "÷",
};
function isBinary(
    expression: Expression
): expression is Extract<Expression, { kind: keyof typeof operators }> {
    return expression.kind in operators;
}
const executionLabels = {
    source: "Pushed down",
    candidate: "Approximate pushdown",
    adapter: "Not pushed down",
    engine: "Not pushed down",
};
const executionDescriptions = {
    source: "Translated to a native source condition; the adapter may also verify returned rows.",
    candidate: "The source narrows candidates; the adapter evaluates the exact condition.",
    engine: "Evaluated by the query engine after loading candidates.",
    adapter: "Evaluated in the adapter; this condition was not sent to the source.",
};

function fieldPath(expression: Expression): { root: Expression; path: string[] } {
    if (expression.kind !== "getAt") return { root: expression, path: [] };
    const parent = fieldPath(expression.value.source);
    return { root: parent.root, path: [...parent.path, ...expression.value.path] };
}

/** All portable expression variants retain their structure, including correlated queries. */
export function QueryExpression({
    expression,
    scope = {},
    ir,
    compactBinding,
    annotations,
    path = [],
    pattern,
}: ExpressionProps) {
    const child = (value: Expression, index = 0, childPattern = false) => (
        <QueryExpression
            expression={value}
            scope={scope}
            ir={ir}
            compactBinding={compactBinding}
            annotations={annotations}
            path={[...path, index]}
            pattern={childPattern}
        />
    );
    if (expression.kind === "literal") {
        const value = expression.value.value;
        if (Array.isArray(value))
            return (
                <div className="ps-query-values">
                    <span className="ps-query-operator">[</span>
                    {value.map((item, index) => (
                        <QueryExpression
                            key={index}
                            expression={{ kind: "literal", value: { value: item } }}
                        />
                    ))}
                    <span className="ps-query-operator">]</span>
                </div>
            );
        if (value !== null && typeof value === "object" && !(value instanceof Date))
            return (
                <div className="ps-query-branches">
                    {Object.entries(value).map(([name, item]) => (
                        <div key={name} className="ps-query-selection">
                            <span className="ps-query-output">{name}</span>
                            <span className="ps-query-operator">:</span>
                            <QueryExpression expression={{ kind: "literal", value: { value: item } }} />
                        </div>
                    ))}
                </div>
            );
        return <OperandToken value={value} pattern={pattern} />;
    }
    if (expression.kind === "getAt") {
        const { root, path: fields } = fieldPath(expression);
        if (
            root.kind === "localReference" ||
            root.kind === "contextReference" ||
            root.kind === "inputReference"
        ) {
            const object = root.kind === "localReference" ? scope[root.value.name] : undefined;
            const name = fields
                .map((field, index) =>
                    index === 0
                        ? (object?.properties.find((property) => property.name === field)?.displayName ??
                          field)
                        : field
                )
                .join(".");
            const prefix =
                root.kind === "localReference"
                    ? root.value.name === compactBinding
                        ? ""
                        : `${root.value.name}.`
                    : `${root.kind === "inputReference" ? "input" : "context"}.${root.value.name}.`;
            return (
                <span className="ps-query-field">
                    {prefix}
                    {name}
                </span>
            );
        }
        return (
            <div className="ps-query-comparison">
                {child(expression.value.source)}
                <span className="ps-query-field">.{expression.value.path.join(".")}</span>
            </div>
        );
    }
    if (
        expression.kind === "localReference" ||
        expression.kind === "contextReference" ||
        expression.kind === "inputReference"
    )
        return (
            <span className="ps-query-field">
                {expression.kind === "localReference"
                    ? ""
                    : expression.kind === "contextReference"
                      ? "context."
                      : "input."}
                {expression.value.name}
            </span>
        );
    if (expression.kind === "and" || expression.kind === "or" || expression.kind === "not") {
        const terms =
            expression.kind === "not" ? [expression.value.expression] : expression.value.expressions;
        if (!terms.length)
            return (
                <span className="ps-query-keyword">{expression.kind === "and" ? "All rows" : "No rows"}</span>
            );
        return (
            <div className="ps-query-group" aria-label={expression.kind.toUpperCase()}>
                <span className="ps-query-connector">{expression.kind.toUpperCase()}</span>
                <div className="ps-query-branches">
                    {terms.map((term, index) => (
                        <Fragment key={index}>{child(term, index)}</Fragment>
                    ))}
                </div>
            </div>
        );
    }
    if (isBinary(expression)) {
        const execution = annotations?.find(
            (annotation) =>
                annotation.path.length === path.length &&
                annotation.path.every((part, index) => part === path[index])
        )?.execution;
        const nullish =
            (expression.kind === "eq" || expression.kind === "ne") &&
            expression.value.right.kind === "literal" &&
            (expression.value.right.value.value === null || expression.value.right.value.value === undefined);
        return (
            <div className="ps-query-comparison" data-execution={execution}>
                {child(expression.value.left)}
                <span className="ps-query-operator">
                    {nullish ? (expression.kind === "ne" ? "is not" : "is") : operators[expression.kind]}
                </span>
                {child(expression.value.right, 1, expression.kind === "like" || expression.kind === "ilike")}
                {execution && (
                    <span className="ps-query-execution-label" title={executionDescriptions[execution]}>
                        {executionLabels[execution]}
                    </span>
                )}
            </div>
        );
    }
    switch (expression.kind) {
        case "lookup":
            return (
                <div className="ps-query-comparison">
                    <span className="ps-query-operator">lookup</span>
                    {child(expression.value.reference)}
                </div>
            );
        case "related":
            return (
                <div className="ps-query-comparison">
                    {child(expression.value.source)}
                    <span className="ps-query-operator">→</span>
                    <span className="ps-query-field">{expression.value.link}</span>
                </div>
            );
        case "concat":
        case "coalesce":
            return (
                <div className="ps-query-group">
                    <span className="ps-query-connector">{expression.kind}</span>
                    <div className="ps-query-branches">
                        {expression.value.expressions.map((value, index) => (
                            <Fragment key={index}>{child(value, index)}</Fragment>
                        ))}
                    </div>
                </div>
            );
        case "struct":
            return (
                <div className="ps-query-branches">
                    {expression.value.fields.map((field, index) => (
                        <div className="ps-query-clause" key={index}>
                            <span className="ps-query-output">{field.name}</span>
                            {child(field.value, index)}
                        </div>
                    ))}
                </div>
            );
        case "map":
            return (
                <div className="ps-query-group">
                    <span className="ps-query-connector">map</span>
                    <div className="ps-query-branches">
                        {child(expression.value.source)}
                        <div className="ps-query-clause">
                            <span className="ps-query-field">{expression.value.binding}</span>
                            <span className="ps-query-operator">→</span>
                            <QueryExpression
                                expression={expression.value.body}
                                scope={{ ...scope, [expression.value.binding]: undefined }}
                                ir={ir}
                                compactBinding={compactBinding}
                            />
                        </div>
                    </div>
                </div>
            );
        case "uuid":
        case "now":
            return <span className="ps-query-field">{expression.kind}()</span>;
        case "case":
            return (
                <div className="ps-query-group">
                    <span className="ps-query-connector">CASE</span>
                    <div className="ps-query-branches">
                        {expression.value.branches.map((branch, index) => (
                            <div key={index} className="ps-query-clause">
                                <span className="ps-query-keyword">when</span>
                                {child(branch.condition, index)}
                                <span className="ps-query-keyword">then</span>
                                {child(branch.result, index)}
                            </div>
                        ))}
                        <div className="ps-query-clause">
                            <span className="ps-query-keyword">else</span>
                            {child(expression.value.else)}
                        </div>
                    </div>
                </div>
            );
        case "exists":
            return (
                <div className="ps-query-group">
                    <span className="ps-query-connector">EXISTS</span>
                    <QueryView query={expression.value.query} ir={ir} scope={scope} />
                </div>
            );
        default: {
            const exhaustive: never = expression;
            return exhaustive;
        }
    }
}

function Selections({
    select,
    ir,
    scope,
}: {
    select: readonly QuerySelection[];
    ir?: OntologyIR;
    scope: Scope;
}) {
    return (
        <div className="ps-query-selections">
            {select.map((selection, index) => {
                switch (selection.kind) {
                    case "sub":
                        return (
                            <QueryView
                                key={index}
                                query={selection.value.query}
                                label={selection.value.name}
                                cardinality={selection.value.cardinality}
                                ir={ir}
                                scope={scope}
                            />
                        );
                    case "field":
                        return (
                            <div className="ps-query-selection" key={index}>
                                <span className="ps-query-output">{selection.value.name}</span>
                                <span className="ps-query-operator">←</span>
                                <QueryExpression
                                    expression={selection.value.expression}
                                    scope={scope}
                                    ir={ir}
                                />
                            </div>
                        );
                    case "selectCase":
                        return (
                            <div className="ps-query-selection-case" key={index}>
                                {selection.value.branches.map((branch, branchIndex) => (
                                    <div key={branchIndex}>
                                        <div className="ps-query-clause">
                                            <span className="ps-query-connector">WHEN</span>
                                            <QueryExpression
                                                expression={branch.condition}
                                                scope={scope}
                                                ir={ir}
                                            />
                                        </div>
                                        <Selections select={branch.select} ir={ir} scope={scope} />
                                    </div>
                                ))}
                                {selection.value.else && (
                                    <div>
                                        <span className="ps-query-connector">ELSE</span>
                                        <Selections select={selection.value.else} ir={ir} scope={scope} />
                                    </div>
                                )}
                            </div>
                        );
                }
            })}
        </div>
    );
}

export function QueryView({
    query,
    ir,
    object,
    scope = {},
    label,
    cardinality,
    compact = false,
    showSubject = true,
    annotations,
}: {
    query: Query;
    ir?: OntologyIR;
    object?: ObjectTypeDef;
    scope?: Scope;
    label?: string;
    cardinality?: "one" | "many";
    compact?: boolean;
    showSubject?: boolean;
    annotations?: Annotations;
}) {
    const type = object ?? ir?.objectTypes.find((type) => type.name === query.from.source.objectType);
    const bindings = { ...scope, [query.from.binding]: type };
    const expressionProps = { scope: bindings, ir, compactBinding: compact ? query.from.binding : undefined };
    const subject = showSubject && <QuerySubject object={type} objectType={query.from.source.objectType} />;
    const clauses = (
        <>
            {query.where ? (
                <div className={compact ? "ps-query-sentence" : "ps-query-clause"}>
                    {compact && subject}
                    <span className="ps-query-keyword">where</span>
                    <QueryExpression
                        {...expressionProps}
                        expression={query.where}
                        annotations={annotations}
                    />
                </div>
            ) : (
                <div className="ps-query-sentence">
                    {compact && subject}
                    <span className="ps-query-keyword">
                        {compact && showSubject ? "— all rows" : "All rows"}
                    </span>
                </div>
            )}
            {query.orderBy?.map((order, index) => (
                <div className="ps-query-clause" key={index}>
                    <span className="ps-query-keyword">order by</span>
                    <QueryExpression {...expressionProps} expression={order.expression} />
                    <span className="ps-query-operator">
                        {order.direction === "desc" ? "descending" : "ascending"}
                        {nullOrderLabel(order)}
                    </span>
                </div>
            ))}
            {query.page?.limit !== undefined && (
                <div className="ps-query-clause">
                    <span className="ps-query-keyword">limit</span>
                    <OperandToken value={query.page.limit} />
                </div>
            )}
            {query.page?.offset !== undefined && (
                <div className="ps-query-clause">
                    <span className="ps-query-keyword">offset</span>
                    <OperandToken value={query.page.offset} />
                </div>
            )}
            {query.page?.after && (
                <div className="ps-query-clause">
                    <span className="ps-query-keyword">after</span>
                    <OperandToken value={query.page.after.key} />
                    <div className="ps-query-values">
                        {query.page.after.values.map((value, index) => (
                            <OperandToken key={index} value={value} />
                        ))}
                    </div>
                </div>
            )}
        </>
    );
    if (compact) return <div className="ps-query-expression">{clauses}</div>;
    return (
        <details className="ps-query-node" open>
            <DisclosureSummary>
                {label && <span className="ps-query-output">{label}</span>}
                {subject}
                <span className="ps-query-binding">as {query.from.binding}</span>
                {cardinality && <span className="ps-query-cardinality">{cardinality}</span>}
                {query.from.source.ontology && (
                    <span className="ps-query-binding">in {query.from.source.ontology}</span>
                )}
            </DisclosureSummary>
            <div className="ps-query-node-body">
                {clauses}
                <Selections select={query.select} ir={ir} scope={bindings} />
            </div>
        </details>
    );
}

export function QueryDocumentView({ query, ir }: { query: QueryDocument; ir: OntologyIR }) {
    return (
        <div className="ps-query-document" aria-label="Pinned query graph">
            {query.inputs && query.inputs.length > 0 && (
                <div className="ps-query-input-definitions">
                    <span className="ps-query-keyword">inputs</span>
                    {query.inputs.map((input) => (
                        <span key={input.name} className="ps-query-field">
                            {input.name}: {typeDisplayName(input.type)}
                        </span>
                    ))}
                </div>
            )}
            <Selections select={query.select} ir={ir} scope={{}} />
        </div>
    );
}
