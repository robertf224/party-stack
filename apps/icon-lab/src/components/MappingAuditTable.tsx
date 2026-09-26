import type { MappingAuditFile } from "../shared/types";

export function MappingAuditTable({
    audit,
    onSelectConcept,
}: {
    audit: MappingAuditFile;
    onSelectConcept: (concept: string) => void;
}) {
    const weakPairs = audit.pairs.slice(0, 40);
    const weakConcepts = audit.conceptScores.slice(0, 30);

    return (
        <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 backdrop-blur">
                <h2 className="text-xl font-semibold">Weakest concepts</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">
                    Sorted by minimum pairwise CLIP similarity across mapped providers.
                </p>
                <div className="mt-4 max-h-[70vh] overflow-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="sticky top-0 bg-white/90 font-[var(--font-mono)] text-[11px] text-[var(--muted)]">
                            <tr>
                                <th className="py-2 pr-3 font-medium">Concept</th>
                                <th className="py-2 pr-3 font-medium">Min</th>
                                <th className="py-2 font-medium">Mean</th>
                            </tr>
                        </thead>
                        <tbody>
                            {weakConcepts.map((row) => (
                                <tr key={row.concept} className="border-t border-[var(--line)]">
                                    <td className="py-2 pr-3">
                                        <button
                                            type="button"
                                            className="text-left font-medium hover:underline"
                                            onClick={() => onSelectConcept(row.concept)}
                                        >
                                            {row.concept}
                                        </button>
                                    </td>
                                    <td
                                        className={`py-2 pr-3 font-[var(--font-mono)] ${
                                            row.minScore < 0.55
                                                ? "text-[var(--bad)]"
                                                : row.minScore < 0.7
                                                  ? "text-[var(--warn)]"
                                                  : "text-[var(--good)]"
                                        }`}
                                    >
                                        {row.minScore.toFixed(3)}
                                    </td>
                                    <td className="py-2 font-[var(--font-mono)]">
                                        {row.meanScore.toFixed(3)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            <section className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 backdrop-blur">
                <h2 className="text-xl font-semibold">Weakest pairs</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">
                    Cross-provider mismatches worth revisiting when expanding the universal set.
                </p>
                <div className="mt-4 max-h-[70vh] overflow-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="sticky top-0 bg-white/90 font-[var(--font-mono)] text-[11px] text-[var(--muted)]">
                            <tr>
                                <th className="py-2 pr-3 font-medium">Concept</th>
                                <th className="py-2 pr-3 font-medium">Pair</th>
                                <th className="py-2 font-medium">Score</th>
                            </tr>
                        </thead>
                        <tbody>
                            {weakPairs.map((pair) => (
                                <tr
                                    key={`${pair.left.id}-${pair.right.id}`}
                                    className="border-t border-[var(--line)]"
                                >
                                    <td className="py-2 pr-3">
                                        <button
                                            type="button"
                                            className="text-left font-medium hover:underline"
                                            onClick={() => onSelectConcept(pair.concept)}
                                        >
                                            {pair.concept}
                                        </button>
                                    </td>
                                    <td className="py-2 pr-3 font-[var(--font-mono)] text-xs">
                                        {pair.left.provider}:{pair.left.name}
                                        <br />
                                        {pair.right.provider}:{pair.right.name}
                                    </td>
                                    <td className="py-2 font-[var(--font-mono)] text-[var(--bad)]">
                                        {pair.score.toFixed(3)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    );
}
