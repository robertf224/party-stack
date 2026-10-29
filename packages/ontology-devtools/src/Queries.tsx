import { useState, useSyncExternalStore, type ReactNode } from "react";
import { DemandHighlight, revealDemandOwners } from "./attribution/Highlight.js";
import { attributionRevision, subscribeAttribution, type DemandOwner } from "./attribution/registry.js";
import { demandOwners, demandRequests } from "./attribution/tanstack.js";
import { useReplicaStatus } from "./diagnostics.js";
import { QueryOwners } from "./QueryOwners.js";
import { QueryPills } from "./QueryPills.js";
import { QueryPushdown, RequestedQuery } from "./QueryPushdown.js";
import { demandId, queryLoads, type ReplicationLoad } from "./replicationActivity.js";
import type { LiveOntology } from "@party-stack/ontology";

const noOwners: readonly DemandOwner[] = [];
const serverRevision = () => 0;

export function QueryLoadStats({
    load,
    replicaName = "replica",
}: {
    load?: ReplicationLoad;
    replicaName?: string;
}) {
    if (!load) return null;
    if (load.outcome === "running") return <>Request in progress…</>;
    if (load.outcome === "interrupted") return <>Request cancelled</>;
    if (load.outcome === "failure") return <>Request failed</>;
    if (load.rows === undefined) return null;
    const fetched = load.fetchedRows;
    if (fetched === undefined || fetched === load.rows)
        return (
            <>
                Loaded <b>{load.rows.toLocaleString()}</b> {load.rows === 1 ? "row" : "rows"}
            </>
        );
    const processing = [
        (load.pushdown?.rechecksFilter ||
            load.pushdown?.predicates.some((term) => term.execution !== "source")) &&
            "filtering",
        load.pushdown?.pagination === "adapter" && "pagination",
    ].filter((step): step is string => typeof step === "string");
    return (
        <span className="ps-query-row-flow" data-reduced={load.rows < fetched || undefined}>
            Loaded <b>{fetched.toLocaleString()}</b> {fetched === 1 ? "row" : "rows"};{" "}
            <b>{load.rows.toLocaleString()}</b> sent to {replicaName}
            {processing.length ? ` after adapter ${processing.join(" and ")}.` : " after adapter processing."}
        </span>
    );
}

export function Queries({ ontology }: { ontology: LiveOntology }) {
    useSyncExternalStore(subscribeAttribution, attributionRevision, serverRevision);
    const [highlighted, highlight] = useState<string>();
    const { status, error } = useReplicaStatus(ontology.diagnostics);
    // Queries remain local; only the correlated load telemetry comes from the exposed upstream owner.
    const { status: parentStatus, error: parentError } = useReplicaStatus(ontology.diagnostics?.parent);
    const loads = ontology.diagnostics?.parent ? parentStatus?.loads : status?.loads;
    const parentReplica = ontology.diagnostics?.parent
        ? (ontology.diagnostics.parent.location ?? ontology.diagnostics.parent.label ?? "Host")
        : undefined;
    const upstreamDemands = new Map(
        (ontology.diagnostics?.parent ? parentStatus : status)?.demands.map((demand) => [
            demandId(demand),
            demand,
        ])
    );
    const demands =
        status?.demands
            .slice()
            .sort(
                (a, b) =>
                    Number(Boolean(b.query?.where)) - Number(Boolean(a.query?.where)) ||
                    a.objectType.localeCompare(b.objectType)
            ) ?? [];
    const ownersByDemand = new Map(
        demands.map((demand) => [demandId(demand), demandOwners(demand, Object.values(ontology.objects))])
    );
    return (
        <div className="ps-diagnostics-screen" aria-label="Queries inspector">
            {error && (
                <p className="ps-replication-error" role="alert">
                    {error} · displayed queries may be stale
                </p>
            )}
            <div className="ps-query-list" aria-label="Active queries">
                {demands.map((demand) => {
                    const object = ontology.ir.objectTypes.find((type) => type.name === demand.objectType);
                    const history = queryLoads(demand, loads ?? []);
                    const latest = history.at(-1);
                    const previousLoad = history.filter((load) => load.outcome === "success").at(-1);
                    const displayedLoad = latest?.outcome === "running" ? (previousLoad ?? latest) : latest;
                    const sourceName = (loads ?? [])
                        .filter((load) => load.subset?.objectType === demand.objectType && load.pushdown)
                        .at(-1)?.pushdown?.source;
                    const key = demandId(demand);
                    const upstreamDemand = upstreamDemands.get(key);
                    const coveredBy =
                        upstreamDemand?.installed === upstreamDemand?.revision
                            ? upstreamDemand?.coveredBy
                            : undefined;
                    const checking =
                        latest?.outcome === "running" ||
                        Boolean(upstreamDemand && upstreamDemand.installed !== upstreamDemand.revision);
                    const owners = ownersByDemand.get(key) ?? noOwners;
                    const requests = demandRequests(demand, Object.values(ontology.objects));
                    return (
                        <article
                            className="ps-query-card"
                            key={key}
                            data-attributed={owners.length > 0 || undefined}
                            aria-busy={checking || undefined}
                            onPointerEnter={() => highlight(key)}
                            onPointerLeave={() => highlight(undefined)}
                        >
                            <header>
                                <span
                                    className="ps-query-refreshing"
                                    data-refreshing={checking}
                                    aria-hidden={!checking}
                                >
                                    Refreshing…
                                </span>
                                <QueryTarget
                                    owners={owners}
                                    label={`Show components for ${object?.pluralDisplayName ?? demand.objectType} query`}
                                    onHighlight={() => highlight(key)}
                                    onClear={() => highlight(undefined)}
                                >
                                    <QueryOwners owners={owners} />
                                    {requests.length ? (
                                        requests.map((request, index) => (
                                            <RequestedQuery
                                                key={index}
                                                request={request}
                                                demand={demand}
                                                object={object}
                                            />
                                        ))
                                    ) : (
                                        <QueryPills
                                            query={demand.query}
                                            object={object}
                                            objectType={demand.objectType}
                                        />
                                    )}
                                </QueryTarget>
                            </header>
                            <QueryPushdown
                                key={ontology.storage?.sourceId}
                                requests={requests}
                                demand={demand}
                                load={latest}
                                previousLoad={previousLoad}
                                sourceName={sourceName}
                                checking={checking}
                                object={object}
                                loadError={parentError}
                                parentReplica={parentReplica}
                                coveredBy={coveredBy}
                                coverageProof={coveredBy ? upstreamDemand?.coverageProof : undefined}
                                loadStats={
                                    <QueryLoadStats
                                        load={displayedLoad}
                                        replicaName={
                                            parentReplica ? `${parentReplica} replica` : "tab replica"
                                        }
                                    />
                                }
                            />
                        </article>
                    );
                })}
                {!demands.length && (
                    <p className="ps-replication-empty">
                        {status ? "No active queries." : "Reading queries…"}
                    </p>
                )}
            </div>
            <DemandHighlight
                owners={highlighted ? (ownersByDemand.get(highlighted) ?? noOwners) : noOwners}
            />
        </div>
    );
}

function QueryTarget({
    owners,
    label,
    onHighlight,
    onClear,
    children,
}: {
    owners: readonly DemandOwner[];
    label: string;
    onHighlight: () => void;
    onClear: () => void;
    children: ReactNode;
}) {
    if (!owners.length) return children;
    return (
        <button
            type="button"
            className="ps-query-component-target"
            aria-label={label}
            onFocus={onHighlight}
            onBlur={onClear}
            onClick={() => revealDemandOwners(owners)}
        >
            {children}
        </button>
    );
}
