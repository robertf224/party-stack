import { useEffect, useMemo, useState } from "react";
import type {
    CatalogFile,
    EmbeddingIndexFile,
    MappingAuditFile,
    CatalogIcon,
    IconProvider,
    DraftMappingsFile,
} from "./shared/types";
import { projectTo2d } from "./shared/math";
import { loadEmbeddingStore, type QuantizedEmbeddingStore } from "./shared/embeddings";
import { IconTile } from "./components/IconTile";
import { EmbeddingScatter } from "./components/EmbeddingScatter";
import { MappingAuditTable } from "./components/MappingAuditTable";
import { DraftMappingBrowser } from "./components/DraftMappingBrowser";

type Tab = "draft" | "concepts" | "audit" | "map" | "neighbors";

const PROVIDER_LABEL: Record<IconProvider, string> = {
    blueprint: "Blueprint / Foundry",
    lucide: "Lucide",
    material: "Material Symbols",
    salesforce: "Salesforce",
    sfsymbols: "SF Symbols",
};

const PROVIDER_COLOR: Record<IconProvider, string> = {
    blueprint: "#2D72D2",
    lucide: "#0f7a6c",
    material: "#c45c26",
    salesforce: "#0176d3",
    sfsymbols: "#5b6b78",
};

export function App() {
    const [catalog, setCatalog] = useState<CatalogFile | null>(null);
    const [embeddingStore, setEmbeddingStore] = useState<QuantizedEmbeddingStore | null>(null);
    const [audit, setAudit] = useState<MappingAuditFile | null>(null);
    const [draft, setDraft] = useState<DraftMappingsFile | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useState<Tab>("draft");
    const [query, setQuery] = useState("");
    const [selectedConcept, setSelectedConcept] = useState<string | null>(null);
    const [neighborSeed, setNeighborSeed] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [catalogRes, embeddingsRes, auditRes, draftRes] = await Promise.all([
                    fetch("/generated-data/catalog.json"),
                    fetch("/generated-data/embeddings-index.json"),
                    fetch("/generated-data/mapping-audit.json"),
                    fetch("/generated-data/draft-mappings.json"),
                ]);
                if (!catalogRes.ok || !embeddingsRes.ok || !auditRes.ok || !draftRes.ok) {
                    throw new Error("Missing generated data. Run `pnpm icons:prepare` in apps/icon-lab.");
                }
                const [catalogJson, embeddingsJson, auditJson, draftJson] = await Promise.all([
                    catalogRes.json() as Promise<CatalogFile>,
                    embeddingsRes.json() as Promise<EmbeddingIndexFile>,
                    auditRes.json() as Promise<MappingAuditFile>,
                    draftRes.json() as Promise<DraftMappingsFile>,
                ]);
                const store = await loadEmbeddingStore(embeddingsJson);
                if (cancelled) {
                    return;
                }
                setCatalog(catalogJson);
                setEmbeddingStore(store);
                setAudit(auditJson);
                setDraft(draftJson);
                setSelectedConcept(catalogJson.concepts[0] ?? null);
                setNeighborSeed(
                    catalogJson.icons.find((icon) => icon.concept === catalogJson.concepts[0])?.id ?? null
                );
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : String(err));
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const iconsByConcept = useMemo(() => {
        const map = new Map<string, CatalogIcon[]>();
        for (const icon of catalog?.icons ?? []) {
            for (const concept of icon.concepts ?? (icon.concept ? [icon.concept] : [])) {
                const list = map.get(concept) ?? [];
                list.push(icon);
                map.set(concept, list);
            }
        }
        return map;
    }, [catalog]);

    const filteredConcepts = useMemo(() => {
        if (!catalog) {
            return [];
        }
        const q = query.trim().toLowerCase();
        const scored = catalog.concepts.map((concept) => {
            const auditRow = audit?.conceptScores.find((row) => row.concept === concept);
            return { concept, minScore: auditRow?.minScore ?? 1, meanScore: auditRow?.meanScore ?? 1 };
        });
        return scored
            .filter((row) => (q ? row.concept.includes(q) : true))
            .sort((a, b) => a.minScore - b.minScore);
    }, [catalog, audit, query]);

    const neighbors = useMemo(() => {
        if (!neighborSeed || !catalog || !embeddingStore?.has(neighborSeed)) {
            return [];
        }
        const seedIcon = catalog.icons.find((icon) => icon.id === neighborSeed);
        return catalog.icons
            .filter((icon) => icon.id !== neighborSeed && embeddingStore.has(icon.id))
            .map((icon) => ({
                icon,
                score: embeddingStore.similarity(neighborSeed, icon.id),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 24)
            .map((row) => ({
                ...row,
                sameProvider: row.icon.provider === seedIcon?.provider,
            }));
    }, [neighborSeed, catalog, embeddingStore]);

    const scatterPoints = useMemo(() => {
        if (!catalog || !embeddingStore) {
            return [];
        }
        const mapped = catalog.icons.filter((icon) => icon.concept && embeddingStore.has(icon.id));
        const vectors = mapped.map((icon) => embeddingStore.vector(icon.id));
        const projected = projectTo2d(vectors);
        return mapped.map((icon, index) => ({
            id: icon.id,
            concept: icon.concept!,
            provider: icon.provider,
            name: icon.name,
            x: projected[index]!.x,
            y: projected[index]!.y,
            color: PROVIDER_COLOR[icon.provider],
        }));
    }, [catalog, embeddingStore]);

    if (error) {
        return (
            <main className="mx-auto max-w-3xl px-6 py-16">
                <h1 className="text-3xl font-semibold tracking-tight">Icon Lab</h1>
                <p className="mt-4 text-[var(--bad)]">{error}</p>
            </main>
        );
    }

    if (!catalog || !embeddingStore || !audit || !draft) {
        return (
            <main className="mx-auto max-w-3xl px-6 py-16">
                <h1 className="text-3xl font-semibold tracking-tight">Icon Lab</h1>
                <p className="mt-4 text-[var(--muted)]">Loading catalog + embeddings…</p>
            </main>
        );
    }

    const selectedIcons = selectedConcept ? (iconsByConcept.get(selectedConcept) ?? []) : [];
    const selectedAudit = audit.conceptScores.find((row) => row.concept === selectedConcept);

    return (
        <div className="min-h-screen">
            <header className="border-b border-[var(--line)] bg-[var(--panel)] backdrop-blur-md">
                <div className="mx-auto flex max-w-[1600px] flex-wrap items-end justify-between gap-4 px-6 py-5">
                    <div>
                        <p className="text-xs font-[var(--font-mono)] uppercase tracking-[0.18em] text-[var(--muted)]">
                            party-stack / apps
                        </p>
                        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Icon Lab</h1>
                        <p className="mt-1 max-w-2xl text-sm text-[var(--muted)]">
                            Multimodal embeddings across Blueprint, Lucide, Material, Salesforce, and SF
                            Symbols — build and stress-test the universal set.
                        </p>
                    </div>
                    <div className="text-xs font-[var(--font-mono)] text-[var(--muted)]">
                        <div>{catalog.icons.length} icons indexed</div>
                        <div>
                            {embeddingStore.index.ids.length} embeddings · {embeddingStore.index.dims}d ·{" "}
                            {embeddingStore.index.model.replace("Xenova/", "")}
                        </div>
                    </div>
                </div>
                <nav className="mx-auto flex max-w-[1600px] gap-1 px-6 pb-3">
                    {(
                        [
                            ["draft", `Blueprint draft · ${draft.mappings.length}`],
                            ["concepts", "Universal set"],
                            ["audit", "Mapping audit"],
                            ["map", "Embedding map"],
                            ["neighbors", "Neighbors"],
                        ] as const
                    ).map(([id, label]) => (
                        <button
                            key={id}
                            type="button"
                            onClick={() => setTab(id)}
                            className={`rounded-md px-3 py-1.5 text-sm transition ${
                                tab === id
                                    ? "bg-[var(--ink)] text-white"
                                    : "text-[var(--muted)] hover:bg-white/70 hover:text-[var(--ink)]"
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </nav>
            </header>

            <main className="mx-auto max-w-[1600px] px-6 py-6">
                {tab === "draft" && <DraftMappingBrowser catalog={catalog} draft={draft} />}

                {tab === "concepts" && (
                    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
                        <aside className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-3 backdrop-blur">
                            <input
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder="Filter concepts…"
                                className="mb-3 w-full rounded-lg border border-[var(--line)] bg-white/80 px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                            />
                            <div className="max-h-[70vh] space-y-1 overflow-auto pr-1">
                                {filteredConcepts.map((row) => (
                                    <button
                                        key={row.concept}
                                        type="button"
                                        onClick={() => {
                                            setSelectedConcept(row.concept);
                                            const first = iconsByConcept.get(row.concept)?.[0];
                                            if (first) {
                                                setNeighborSeed(first.id);
                                            }
                                        }}
                                        className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm transition ${
                                            selectedConcept === row.concept
                                                ? "bg-[var(--ink)] text-white"
                                                : "hover:bg-white/80"
                                        }`}
                                    >
                                        <span className="font-medium">{row.concept}</span>
                                        <span
                                            className={`text-[11px] font-[var(--font-mono)] ${
                                                selectedConcept === row.concept
                                                    ? "text-white/70"
                                                    : row.minScore < 0.55
                                                      ? "text-[var(--bad)]"
                                                      : row.minScore < 0.7
                                                        ? "text-[var(--warn)]"
                                                        : "text-[var(--good)]"
                                            }`}
                                        >
                                            {row.minScore.toFixed(2)}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </aside>

                        <section className="space-y-4">
                            <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 backdrop-blur">
                                <div className="flex flex-wrap items-end justify-between gap-3">
                                    <div>
                                        <h2 className="text-2xl font-semibold tracking-tight">
                                            {selectedConcept}
                                        </h2>
                                        <p className="mt-1 text-sm text-[var(--muted)]">
                                            Side-by-side provider glyphs for this universal concept. Scores
                                            are CLIP cosine similarity across the mapped set.
                                        </p>
                                    </div>
                                    {selectedAudit && (
                                        <div className="text-xs font-[var(--font-mono)] text-[var(--muted)]">
                                            min {selectedAudit.minScore.toFixed(3)} · mean{" "}
                                            {selectedAudit.meanScore.toFixed(3)} · {selectedAudit.pairCount}{" "}
                                            pairs
                                        </div>
                                    )}
                                </div>

                                <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                                    {selectedIcons.map((icon) => (
                                        <button
                                            key={icon.id}
                                            type="button"
                                            onClick={() => {
                                                setNeighborSeed(icon.id);
                                                setTab("neighbors");
                                            }}
                                            className="rounded-xl border border-[var(--line)] bg-white/70 p-3 text-left transition hover:-translate-y-0.5 hover:shadow-sm"
                                        >
                                            <div className="mb-2 flex items-center justify-between gap-2">
                                                <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
                                                    {PROVIDER_LABEL[icon.provider]}
                                                </span>
                                                <span
                                                    className="h-2 w-2 rounded-full"
                                                    style={{ background: PROVIDER_COLOR[icon.provider] }}
                                                />
                                            </div>
                                            <IconTile icon={icon} size={56} />
                                            <div className="mt-3 break-all text-xs font-[var(--font-mono)]">
                                                {icon.name}
                                            </div>
                                            {icon.textOnly && (
                                                <div className="mt-1 text-[11px] text-[var(--warn)]">
                                                    text-only (no redistributable glyph)
                                                </div>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 backdrop-blur">
                                <h3 className="text-sm font-semibold uppercase tracking-wide">
                                    Pairwise similarities
                                </h3>
                                <div className="mt-3 overflow-auto">
                                    <table className="w-full text-left text-sm">
                                        <thead className="text-[11px] font-[var(--font-mono)] text-[var(--muted)]">
                                            <tr>
                                                <th className="py-2 pr-3 font-medium">Left</th>
                                                <th className="py-2 pr-3 font-medium">Right</th>
                                                <th className="py-2 font-medium">Score</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {audit.pairs
                                                .filter((pair) => pair.concept === selectedConcept)
                                                .sort((a, b) => a.score - b.score)
                                                .map((pair) => (
                                                    <tr
                                                        key={`${pair.left.id}-${pair.right.id}`}
                                                        className="border-t border-[var(--line)]"
                                                    >
                                                        <td className="py-2 pr-3">
                                                            {pair.left.provider}:{pair.left.name}
                                                        </td>
                                                        <td className="py-2 pr-3">
                                                            {pair.right.provider}:{pair.right.name}
                                                        </td>
                                                        <td
                                                            className={`py-2 font-[var(--font-mono)] ${
                                                                pair.score < 0.55
                                                                    ? "text-[var(--bad)]"
                                                                    : pair.score < 0.7
                                                                      ? "text-[var(--warn)]"
                                                                      : "text-[var(--good)]"
                                                            }`}
                                                        >
                                                            {pair.score.toFixed(3)}
                                                        </td>
                                                    </tr>
                                                ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </section>
                    </div>
                )}

                {tab === "audit" && (
                    <MappingAuditTable
                        audit={audit}
                        onSelectConcept={(concept) => {
                            setSelectedConcept(concept);
                            setTab("concepts");
                        }}
                    />
                )}

                {tab === "map" && (
                    <EmbeddingScatter
                        points={scatterPoints}
                        onSelect={(point) => {
                            setSelectedConcept(point.concept);
                            setNeighborSeed(point.id);
                            setTab("neighbors");
                        }}
                    />
                )}

                {tab === "neighbors" && (
                    <div className="space-y-4">
                        <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 backdrop-blur">
                            <h2 className="text-xl font-semibold">Nearest neighbors</h2>
                            <p className="mt-1 text-sm text-[var(--muted)]">
                                Pick a seed icon from the universal set, then inspect closest embeddings
                                across catalogs — useful for proposing replacement mappings.
                            </p>
                            <div className="mt-4 flex flex-wrap gap-2">
                                {(iconsByConcept.get(selectedConcept ?? "") ?? []).map((icon) => (
                                    <button
                                        key={icon.id}
                                        type="button"
                                        onClick={() => setNeighborSeed(icon.id)}
                                        className={`rounded-lg border px-3 py-1.5 text-xs ${
                                            neighborSeed === icon.id
                                                ? "border-[var(--ink)] bg-[var(--ink)] text-white"
                                                : "border-[var(--line)] bg-white/70"
                                        }`}
                                    >
                                        {icon.provider}:{icon.name}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                            {neighbors.map(({ icon, score, sameProvider }) => (
                                <div
                                    key={icon.id}
                                    className="rounded-xl border border-[var(--line)] bg-white/75 p-3"
                                >
                                    <div className="mb-2 flex items-center justify-between text-[11px] text-[var(--muted)]">
                                        <span>{PROVIDER_LABEL[icon.provider]}</span>
                                        <span className="font-[var(--font-mono)]">{score.toFixed(3)}</span>
                                    </div>
                                    <IconTile icon={icon} size={44} />
                                    <div className="mt-2 break-all text-xs font-[var(--font-mono)]">
                                        {icon.name}
                                    </div>
                                    <div className="mt-1 text-[11px] text-[var(--muted)]">
                                        {icon.concept ? `mapped → ${icon.concept}` : "unmapped"}
                                        {sameProvider ? " · same provider" : ""}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
}
