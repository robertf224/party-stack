import { IR } from "@tanstack/db";
import { useState, type ReactNode } from "react";
import { DisclosureSummary } from "./DisclosureSummary.js";
import { NativeQueryCode } from "./NativeQueryCode.js";
import { OperandToken, QueryPills, QuerySubject, nullOrderLabel } from "./QueryPills.js";
import { demandId } from "./replicationActivity.js";
import type { ReplicationLoad, ReplicationDemand } from "./replicationActivity.js";
import type { ObjectTypeDef } from "@party-stack/ontology";
import type { CollectionDemandDiagnostic } from "@party-stack/ontology-tanstack";

const operators: Readonly<Record<string, string>> = {
    eq: "=",
    gt: ">",
    gte: "≥",
    lt: "<",
    lte: "≤",
    like: "matches",
    ilike: "matches (ignore case)",
    in: "in",
};
function Expression({
    expression,
    object,
    pattern = false,
}: {
    expression: IR.BasicExpression;
    object?: ObjectTypeDef;
    pattern?: boolean;
}) {
    if (expression.type === "ref")
        return (
            <OperandToken
                value={{ _tag: "Field", path: IR.getPropRefPropertyPath(expression) }}
                object={object}
            />
        );
    if (expression.type === "val") {
        if (Array.isArray(expression.value))
            return (
                <span className="ps-query-values">
                    [
                    {expression.value.map((value, index) => (
                        <Expression key={index} expression={new IR.Value(value)} object={object} />
                    ))}
                    ]
                </span>
            );
        if (
            expression.value === null ||
            expression.value === undefined ||
            ["string", "number", "boolean", "bigint"].includes(typeof expression.value)
        )
            return <OperandToken value={expression.value} object={object} pattern={pattern} />;
        return <code>{JSON.stringify(expression.value)}</code>;
    }
    if (expression.type !== "func") return <span>Unknown expression</span>;
    const { name, args } = expression;
    if (name === "and" || name === "or" || name === "not")
        return (
            <div className="ps-query-group">
                <span className="ps-query-connector">{name.toUpperCase()}</span>
                <div className="ps-query-branches">
                    {args.map((arg, index) => (
                        <Expression key={index} expression={arg} object={object} />
                    ))}
                </div>
            </div>
        );
    return (
        <div className="ps-query-comparison">
            {operators[name] && args.length === 2 ? (
                <>
                    <Expression expression={args[0]!} object={object} />
                    <span className="ps-query-operator">{operators[name]}</span>
                    <Expression
                        expression={args[1]!}
                        object={object}
                        pattern={name === "like" || name === "ilike"}
                    />
                </>
            ) : (
                <>
                    <span className="ps-query-operator">{name}(</span>
                    {args.map((arg, index) => (
                        <span key={index}>
                            {index > 0 && ", "}
                            <Expression expression={arg} object={object} />
                        </span>
                    ))}
                    <span className="ps-query-operator">)</span>
                </>
            )}
        </div>
    );
}

export function RequestedQuery({
    request,
    demand,
    object,
}: {
    request: CollectionDemandDiagnostic;
    demand: ReplicationDemand;
    object?: ObjectTypeDef;
}) {
    const query = request.requested;
    return (
        <div className="ps-query-expression" aria-label="Requested query">
            <div className="ps-query-sentence">
                <QuerySubject object={object} objectType={demand.objectType} />
                {query?.where ? (
                    <>
                        <span className="ps-query-keyword">where</span>
                        <Expression expression={query.where} object={object} />
                    </>
                ) : (
                    <span className="ps-query-keyword">— all rows</span>
                )}
            </div>
            {query?.orderBy?.map((order, index) => (
                <div className="ps-query-clause" key={index}>
                    <span className="ps-query-keyword">order by</span>
                    <Expression expression={order.expression} object={object} />
                    <span className="ps-query-operator">
                        {order.compareOptions.direction === "desc" ? "descending" : "ascending"}
                        {nullOrderLabel(order.compareOptions)}
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
            {query?.cursor && (
                <div className="ps-query-clause">
                    <span className="ps-query-keyword">cursor</span>
                    <Expression
                        expression={new IR.Func("or", [query.cursor.whereFrom, query.cursor.whereCurrent])}
                        object={object}
                    />
                </div>
            )}
        </div>
    );
}

function formatInterval(ms: number | undefined) {
    if (ms === undefined) return "configured interval";
    if (ms % 60_000 === 0) return `${ms / 60_000} ${ms === 60_000 ? "minute" : "minutes"}`;
    if (ms % 1000 === 0) return `${ms / 1000} ${ms === 1000 ? "second" : "seconds"}`;
    return `${ms} ms`;
}

function StepNote({ label, children }: { label: "Filter" | "Data"; children: ReactNode }) {
    return (
        <p className="ps-query-step-note">
            <strong>{label}:</strong> {children}
        </p>
    );
}

export function QueryPushdown({
    requests,
    demand,
    load,
    object,
    loadStats,
    loadError,
    parentReplica,
    coveredBy: checkedCoverage,
    coverageProof: checkedProof,
    previousLoad,
    sourceName,
    checking = false,
}: {
    requests: readonly CollectionDemandDiagnostic[];
    demand: ReplicationDemand;
    load?: ReplicationLoad;
    object?: ObjectTypeDef;
    loadStats?: ReactNode;
    loadError?: string;
    parentReplica?: string;
    coveredBy?: ReplicationDemand["coveredBy"];
    coverageProof?: ReplicationDemand["coverageProof"];
    previousLoad?: ReplicationLoad;
    sourceName?: string;
    checking?: boolean;
}) {
    const preserved = requests.every((request) => (request.filterExact ?? request.exact) === true);
    const incompleteFilter = requests.some((request) => (request.filterExact ?? request.exact) === false);
    const localOrder = requests.some((request) => request.orderExact === false);
    const localLimit = requests.some(
        (request) => request.requested?.limit !== undefined && request.query?.limit === undefined
    );
    const localSteps = [
        incompleteFilter && "This tab filters the replica’s response to finish evaluating the query.",
        localOrder && "This tab sorts the replica’s response.",
        localLimit && "This tab applies the query limit to the replica’s response.",
    ].filter((step): step is string => typeof step === "string");
    const queryId = demandId(demand);
    const [lastCheck, setLastCheck] = useState({
        queryId,
        coveredBy: checkedCoverage,
        coverageProof: checkedProof,
        refresh: checkedProof,
    });
    // Keep the last completed decision visible while a refresh is being checked.
    if (
        lastCheck.queryId !== queryId ||
        (!checking && (lastCheck.coveredBy !== checkedCoverage || lastCheck.coverageProof !== checkedProof))
    ) {
        setLastCheck({
            queryId,
            coveredBy: checkedCoverage,
            coverageProof: checkedProof,
            refresh: checkedProof ?? (lastCheck.queryId === queryId ? lastCheck.refresh : undefined),
        });
    }
    const coveredBy = checking && lastCheck.queryId === queryId ? lastCheck.coveredBy : checkedCoverage;
    const coverageProof = checking && lastCheck.queryId === queryId ? lastCheck.coverageProof : checkedProof;
    const refreshProof = coverageProof ?? (lastCheck.queryId === queryId ? lastCheck.refresh : undefined);
    const displayedLoad = load?.outcome === "running" ? (previousLoad ?? load) : load;
    const plan = displayedLoad?.pushdown ?? previousLoad?.pushdown;
    const source = plan?.source ?? sourceName ?? "Source";
    const sourceReplica = parentReplica ? `${parentReplica} replica` : "Tab replica";
    const reused = Boolean(coveredBy);
    const sameQuery = coveredBy && demandId(coveredBy) === demandId(demand);
    const coverageReason =
        coverageProof &&
        {
            collection: sameQuery
                ? "This query previously loaded the complete collection."
                : "Complete collection; includes every matching row.",
            query: "Previously loaded complete result of the same query or primary-key lookup.",
            "primary-key": "Requested primary key is present in this maintained result.",
        }[coverageProof.reason];
    const residualFilter = plan?.predicates.some((term) => term.execution !== "source");
    const filterStatus = plan?.predicates.length
        ? plan.predicates.every((term) => term.execution === "source")
            ? incompleteFilter
                ? `Fully pushed down to ${source}; this tab still evaluates the remaining conditions.`
                : `Fully pushed down to ${source}.`
            : plan.predicates.every((term) => term.execution === "adapter")
              ? `Not pushed down to ${source}.`
              : `Partly pushed down to ${source}.`
        : (load?.subset?.query ?? demand.query)?.where
          ? "Pushdown not reported."
          : "No filter requested.";
    const adapterSteps = [
        residualFilter && `The adapter filters ${source}’s response to finish evaluating the query.`,
        plan?.rechecksFilter &&
            !residualFilter &&
            load?.fetchedRows !== undefined &&
            load.rows !== undefined &&
            load.fetchedRows !== load.rows &&
            "The adapter also checks returned rows against the filter.",
        plan?.sorting === "adapter" && "The adapter sorts the returned rows.",
        plan?.pagination === "adapter" &&
            `The adapter applies the query limit or pagination before returning rows to the ${sourceReplica}.`,
    ].filter((step): step is string => typeof step === "string");
    const refreshDescription = refreshProof && (
        <span className="ps-query-refresh">
            {refreshProof.maintainedBy === "journal"
                ? "Refreshed through journal catch-up."
                : refreshProof.maintainedBy === "poll"
                  ? `Refreshed by polling every ${formatInterval(refreshProof.pollIntervalMs)}.`
                  : "Refreshed by source change notifications."}
        </span>
    );
    const sourceDetails = (
        <>
            <StepNote label="Filter">
                {displayedLoad
                    ? plan
                        ? filterStatus
                        : "Pushdown not reported."
                    : "No pushdown recorded for this query."}
            </StepNote>
            {plan && displayedLoad && (
                <QueryPills
                    query={displayedLoad.subset?.query ?? demand.query}
                    object={object}
                    annotations={plan.predicates}
                />
            )}
            {adapterSteps.map((step) => (
                <p className="ps-query-step-note" key={step}>
                    {step}
                </p>
            ))}
            <StepNote label="Data">
                {displayedLoad ? loadStats : "No source load recorded for this query."}
                {refreshDescription && <> · {refreshDescription}</>}
            </StepNote>
            {displayedLoad?.error && <p className="ps-query-residual">{displayedLoad.error.message}</p>}
            {plan?.native && (
                <details className="ps-query-native">
                    <DisclosureSummary>Native query ({plan.native.language.toUpperCase()})</DisclosureSummary>
                    <NativeQueryCode language={plan.native.language} text={plan.native.text} />
                </details>
            )}
        </>
    );
    const replicaOutcome = loadError ? (
        <StepNote label="Data">Diagnostics disconnected: {loadError}</StepNote>
    ) : coveredBy ? (
        <>
            <StepNote label="Data">
                {sameQuery
                    ? "Reused this query’s previous result; no upstream request needed."
                    : "Satisfied by local coverage; no upstream request needed."}
            </StepNote>
            <div className="ps-query-data-details">
                <section className="ps-query-data-section" aria-label="Coverage">
                    <h5>Coverage</h5>
                    {coverageReason && <p className="ps-query-step-note">{coverageReason}</p>}
                    {!sameQuery && (
                        <QueryPills query={coveredBy.query} object={object} objectType={demand.objectType} />
                    )}
                </section>
            </div>
        </>
    ) : load ? (
        <>
            <StepNote label="Data">
                {load.outcome === "running" ? `Requesting from ${source}.` : `Requested from ${source}.`}
            </StepNote>
            {displayedLoad?.outcome === "success" && displayedLoad.complete && (
                <div className="ps-query-data-details">
                    <section className="ps-query-data-section" aria-label="Coverage">
                        <h5>Coverage</h5>
                        <p className="ps-query-step-note">Complete result from the last source load.</p>
                    </section>
                </div>
            )}
        </>
    ) : (
        <StepNote label="Data">No recorded source load. Coverage could not be determined.</StepNote>
    );
    return (
        <details className="ps-query-pushdown">
            <DisclosureSummary>Query path</DisclosureSummary>
            <div className="ps-query-execution" aria-label="Query execution">
                <section
                    className="ps-query-step"
                    data-stage-state={
                        !parentReplica && checking && load?.outcome !== "running"
                            ? "active"
                            : !parentReplica && reused
                              ? "cached"
                              : "ready"
                    }
                >
                    <h4>
                        <span aria-hidden>1</span>Tab replica
                    </h4>
                    <StepNote label="Filter">
                        {requests.length === 0
                            ? "Translation not reported."
                            : preserved
                              ? demand.query?.where || requests.some((request) => request.requested?.where)
                                  ? "Unchanged."
                                  : "No filter requested."
                              : incompleteFilter
                                ? "Broadened; remaining conditions evaluated in this tab."
                                : "Translation not reported."}
                    </StepNote>
                    {requests.length === 0 || !preserved || localOrder || localLimit ? (
                        <QueryPills query={demand.query} object={object} />
                    ) : null}
                    {localSteps.map((step) => (
                        <p className="ps-query-step-note" key={step}>
                            {step}
                        </p>
                    ))}
                    {parentReplica ? (
                        <StepNote label="Data">Live demand forwarded to the {sourceReplica}.</StepNote>
                    ) : (
                        replicaOutcome
                    )}
                </section>
                {parentReplica && (
                    <section
                        className="ps-query-step"
                        data-stage-state={
                            checking && load?.outcome !== "running" ? "active" : reused ? "cached" : "ready"
                        }
                    >
                        <h4>
                            <span aria-hidden>2</span>
                            {sourceReplica}
                        </h4>
                        <StepNote label="Filter">
                            {demand.query?.where ? "Unchanged." : "No filter requested."}
                        </StepNote>
                        {replicaOutcome}
                    </section>
                )}
                <section
                    className="ps-query-step"
                    data-stage-state={load?.outcome === "running" ? "active" : reused ? "skipped" : "ready"}
                    data-source-state={
                        loadError
                            ? "unknown"
                            : load?.outcome === "running"
                              ? "refreshing"
                              : reused
                                ? "cached"
                                : load
                                  ? "requested"
                                  : "unknown"
                    }
                >
                    <h4>
                        <span aria-hidden>{parentReplica ? 3 : 2}</span>
                        {source}
                        <span className="ps-query-source-status">
                            {loadError
                                ? "Status unavailable"
                                : load?.outcome === "running"
                                  ? "Source request in progress"
                                  : checking
                                    ? "Checking replica coverage"
                                    : reused
                                      ? "Skipped · replica cache hit"
                                      : load?.outcome === "failure"
                                        ? "Source request failed"
                                        : load?.outcome === "interrupted"
                                          ? "Source request cancelled"
                                          : load
                                            ? "Source request completed"
                                            : "No recorded load"}
                        </span>
                    </h4>
                    {sourceDetails}
                </section>
            </div>
        </details>
    );
}
