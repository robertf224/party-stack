import { createFileRoute, Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import type { MetaLinkType } from "@party-stack/ontology";
import { useOntology } from "../ontology/OntologyProvider";

export const Route = createFileRoute("/")({
    component: Dashboard,
});

function Dashboard() {
    const { meta } = useOntology();

    const { data: objectTypes } = useLiveQuery(
        (q) =>
            q
                .from({ ot: meta.objects.ObjectType })
                .select(({ ot }) => ({ ...ot }))
                .orderBy(({ ot }) => ot.displayName, "asc"),
        [],
    );

    const { data: linkTypes } = useLiveQuery(
        (q) =>
            q
                .from({ lt: meta.objects.LinkType })
                .select(({ lt }) => ({ ...lt }))
                .orderBy(({ lt }) => lt.id, "asc"),
        [],
    );

    return (
        <div className="mx-auto max-w-5xl p-8">
            <div className="mb-10">
                <h1 className="text-2xl font-bold text-zinc-100">Ontology Overview</h1>
                <p className="mt-1 text-sm text-zinc-400">
                    Explore your ontology&apos;s object types, action types, and link types.
                </p>
            </div>

            <section className="mb-10">
                <div className="mb-4 flex items-center gap-3">
                    <h2 className="text-lg font-semibold text-zinc-200">Object Types</h2>
                    <span className="rounded-full bg-blue-900/40 px-2 py-0.5 text-xs font-medium text-blue-300">
                        {objectTypes.length}
                    </span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {objectTypes.map((ot) => (
                        <Link
                            key={ot.name}
                            to="/object-types/$objectType"
                            params={{ objectType: ot.name }}
                            className="group rounded-xl border border-zinc-800 bg-zinc-900 p-4 transition-colors hover:border-zinc-700 hover:bg-zinc-800/80"
                        >
                            <div className="mb-1 text-sm font-semibold text-zinc-100 group-hover:text-blue-400">
                                {ot.displayName}
                            </div>
                            <div className="mb-2 text-xs text-zinc-500">{ot.name}</div>
                            {ot.description && (
                                <p className="mb-2 line-clamp-2 text-xs text-zinc-400">{ot.description as string}</p>
                            )}
                            <div className="flex items-center gap-3 text-xs text-zinc-500">
                                <span>{(ot.properties as unknown[]).length} properties</span>
                                <span>PK: {ot.primaryKey as string}</span>
                            </div>
                        </Link>
                    ))}
                </div>
            </section>

            <section className="mb-10">
                <div className="mb-4 flex items-center gap-3">
                    <h2 className="text-lg font-semibold text-zinc-200">Action Types</h2>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
                    Action types can be browsed by navigating directly to a specific action type.
                    The Foundry adapter loads action types on-demand by name.
                </div>
            </section>

            <section>
                <div className="mb-4 flex items-center gap-3">
                    <h2 className="text-lg font-semibold text-zinc-200">Link Types</h2>
                    <span className="rounded-full bg-amber-900/40 px-2 py-0.5 text-xs font-medium text-amber-300">
                        {linkTypes.length}
                    </span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {linkTypes.map((lt) => (
                        <Link
                            key={lt.id as string}
                            to="/link-types/$linkType"
                            params={{ linkType: lt.id as string }}
                            className="group rounded-xl border border-zinc-800 bg-zinc-900 p-4 transition-colors hover:border-zinc-700 hover:bg-zinc-800/80"
                        >
                            <div className="mb-2 text-sm font-semibold text-zinc-100 group-hover:text-amber-400">
                                {lt.id as string}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-zinc-400">
                                <span className="text-zinc-300">{(lt.source as MetaLinkType["source"]).objectType}</span>
                                <span className="text-zinc-600">→</span>
                                <span className="text-zinc-300">{(lt.target as MetaLinkType["target"]).objectType}</span>
                                <span className="ml-auto rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-500">
                                    {lt.cardinality as string}
                                </span>
                            </div>
                        </Link>
                    ))}
                </div>
            </section>
        </div>
    );
}
