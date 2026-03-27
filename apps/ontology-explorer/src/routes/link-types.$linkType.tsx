import { createFileRoute, Link } from "@tanstack/react-router";
import { eq, useLiveQuery } from "@tanstack/react-db";
import type { MetaLinkType } from "@party-stack/ontology";
import { useOntology } from "../ontology/OntologyProvider";

export const Route = createFileRoute("/link-types/$linkType")({
    component: LinkTypeDetail,
});

function LinkTypeDetail() {
    const { meta: metaOntology } = useOntology();
    const { linkType: linkTypeId } = Route.useParams();

    const { data: linkType } = useLiveQuery(
        (q) =>
            q
                .from({ lt: metaOntology.objects.LinkType })
                .where(({ lt }) => eq(lt.id, linkTypeId))
                .select(({ lt }) => ({ ...lt }))
                .findOne(),
        [linkTypeId],
    );

    if (!linkType) {
        return (
            <div className="flex items-center justify-center p-16 text-zinc-500">
                Loading link type...
            </div>
        );
    }

    const source = linkType.source as MetaLinkType["source"];
    const target = linkType.target as MetaLinkType["target"];

    return (
        <div className="mx-auto max-w-5xl p-8">
            <div className="mb-8">
                <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-300">
                    ← Back
                </Link>
                <h1 className="mt-3 text-2xl font-bold text-zinc-100">{linkType.id as string}</h1>
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
                    <h2 className="mb-4 text-sm font-medium text-zinc-400 uppercase tracking-wider">Source</h2>
                    <div className="space-y-3">
                        <div>
                            <div className="text-xs text-zinc-500">Object Type</div>
                            <Link
                                to="/object-types/$objectType"
                                params={{ objectType: source.objectType }}
                                className="text-sm font-medium text-blue-400 hover:text-blue-300 hover:underline"
                            >
                                {source.objectType}
                            </Link>
                        </div>
                        <div>
                            <div className="text-xs text-zinc-500">Link Name</div>
                            <div className="text-sm text-zinc-200">{source.displayName}</div>
                        </div>
                        <div>
                            <div className="text-xs text-zinc-500">API Name</div>
                            <div className="font-mono text-xs text-zinc-400">{source.name}</div>
                        </div>
                    </div>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
                    <h2 className="mb-4 text-sm font-medium text-zinc-400 uppercase tracking-wider">Target</h2>
                    <div className="space-y-3">
                        <div>
                            <div className="text-xs text-zinc-500">Object Type</div>
                            <Link
                                to="/object-types/$objectType"
                                params={{ objectType: target.objectType }}
                                className="text-sm font-medium text-blue-400 hover:text-blue-300 hover:underline"
                            >
                                {target.objectType}
                            </Link>
                        </div>
                        <div>
                            <div className="text-xs text-zinc-500">Link Name</div>
                            <div className="text-sm text-zinc-200">{target.displayName}</div>
                        </div>
                        <div>
                            <div className="text-xs text-zinc-500">API Name</div>
                            <div className="font-mono text-xs text-zinc-400">{target.name}</div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
                <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
                    <div className="text-xs text-zinc-500">Foreign Key</div>
                    <div className="mt-1 font-mono text-sm text-zinc-200">{linkType.foreignKey as string}</div>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
                    <div className="text-xs text-zinc-500">Cardinality</div>
                    <div className="mt-1 text-sm font-medium text-zinc-200">{linkType.cardinality as string}</div>
                </div>
            </div>

            <div className="mt-10 flex items-center justify-center">
                <div className="flex items-center gap-6">
                    <div className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-center">
                        <div className="text-xs text-zinc-500">Source</div>
                        <Link
                            to="/object-types/$objectType"
                            params={{ objectType: source.objectType }}
                            className="text-sm font-medium text-blue-400 hover:underline"
                        >
                            {source.objectType}
                        </Link>
                    </div>
                    <div className="flex flex-col items-center">
                        <div className="text-xs text-zinc-500">{source.displayName}</div>
                        <div className="my-1 h-px w-24 bg-zinc-600" />
                        <div className="text-[10px] text-zinc-600">
                            {linkType.cardinality as string}
                        </div>
                    </div>
                    <div className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-center">
                        <div className="text-xs text-zinc-500">Target</div>
                        <Link
                            to="/object-types/$objectType"
                            params={{ objectType: target.objectType }}
                            className="text-sm font-medium text-blue-400 hover:underline"
                        >
                            {target.objectType}
                        </Link>
                    </div>
                </div>
            </div>
        </div>
    );
}
