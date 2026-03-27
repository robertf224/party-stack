import { createFileRoute, Link } from "@tanstack/react-router";
import { eq, useLiveQuery } from "@tanstack/react-db";
import type { ActionParameterDef, ActionLogicStep } from "@party-stack/ontology";
import { useOntology } from "../ontology/OntologyProvider";
import { TypeDefLabel } from "../components/TypeDefLabel";

export const Route = createFileRoute("/action-types/$actionType")({
    component: ActionTypeDetail,
});

function ActionTypeDetail() {
    const { meta: metaOntology } = useOntology();
    const { actionType: actionTypeName } = Route.useParams();

    const { data: actionType } = useLiveQuery(
        (q) =>
            q
                .from({ at: metaOntology.objects.ActionType })
                .where(({ at }) => eq(at.name, actionTypeName))
                .select(({ at }) => ({ ...at }))
                .findOne(),
        [actionTypeName],
    );

    if (!actionType) {
        return (
            <div className="flex items-center justify-center p-16 text-zinc-500">
                Loading action type...
            </div>
        );
    }

    const parameters = actionType.parameters as ActionParameterDef[];
    const logic = actionType.logic as ActionLogicStep[];

    return (
        <div className="mx-auto max-w-5xl p-8">
            <div className="mb-8">
                <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-300">
                    ← Back
                </Link>
                <h1 className="mt-3 text-2xl font-bold text-zinc-100">
                    {actionType.displayName as string}
                </h1>
                <div className="mt-1 text-sm text-zinc-400">
                    <span className="font-mono text-xs">{actionType.name as string}</span>
                </div>
                {actionType.description && (
                    <p className="mt-2 text-sm text-zinc-400">{actionType.description as string}</p>
                )}
            </div>

            <section className="mb-10">
                <h2 className="mb-4 text-lg font-semibold text-zinc-200">Parameters</h2>
                <div className="overflow-hidden rounded-xl border border-zinc-800">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-zinc-800 bg-zinc-900/50">
                                <th className="px-4 py-2.5 text-left font-medium text-zinc-400">Name</th>
                                <th className="px-4 py-2.5 text-left font-medium text-zinc-400">API Name</th>
                                <th className="px-4 py-2.5 text-left font-medium text-zinc-400">Type</th>
                                <th className="px-4 py-2.5 text-left font-medium text-zinc-400">Default</th>
                                <th className="px-4 py-2.5 text-left font-medium text-zinc-400">Description</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800/60">
                            {parameters.map((param) => (
                                <tr key={param.name} className="hover:bg-zinc-900/30">
                                    <td className="px-4 py-2 font-medium text-zinc-200">
                                        {param.displayName}
                                    </td>
                                    <td className="px-4 py-2 font-mono text-xs text-zinc-400">{param.name}</td>
                                    <td className="px-4 py-2 font-mono text-xs">
                                        <TypeDefLabel type={param.type} />
                                    </td>
                                    <td className="px-4 py-2 text-xs text-zinc-500">
                                        {param.defaultValue ? (
                                            <ExpressionLabel expression={param.defaultValue} />
                                        ) : (
                                            "—"
                                        )}
                                    </td>
                                    <td className="px-4 py-2 text-zinc-500">{param.description ?? "—"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            {logic.length > 0 && (
                <section>
                    <h2 className="mb-4 text-lg font-semibold text-zinc-200">Logic Steps</h2>
                    <div className="flex flex-col gap-3">
                        {logic.map((step, idx) => (
                            <LogicStepCard key={idx} step={step} index={idx} />
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}

function ExpressionLabel({ expression }: { expression: unknown }) {
    const expr = expression as { kind: string; value: Record<string, unknown> };
    switch (expr.kind) {
        case "functionCall": {
            const fn = expr.value as { kind: string };
            return <span className="text-violet-400">{fn.kind}()</span>;
        }
        case "valueReference": {
            const ref = expr.value as { path: string[] };
            return <span className="text-cyan-400">{ref.path.join(".")}</span>;
        }
        case "contextReference": {
            const ref = expr.value as { path: string[] };
            return <span className="text-amber-400">ctx.{ref.path.join(".")}</span>;
        }
        case "literal":
            return <span className="text-zinc-300">{JSON.stringify(expr.value)}</span>;
        default:
            return <span className="text-zinc-500">{expr.kind}</span>;
    }
}

function LogicStepCard({ step, index }: { step: ActionLogicStep; index: number }) {
    return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="mb-2 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-800 text-xs font-medium text-zinc-400">
                    {index + 1}
                </span>
                <span className="text-sm font-semibold capitalize text-zinc-200">{step.kind}</span>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-400">
                {JSON.stringify(step.value, null, 2)}
            </pre>
        </div>
    );
}
