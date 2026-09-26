import { useMemo, useState } from "react";
import type { IconProvider } from "../shared/types";

export interface ScatterPoint {
    id: string;
    concept: string;
    provider: IconProvider;
    name: string;
    x: number;
    y: number;
    color: string;
}

export function EmbeddingScatter({
    points,
    onSelect,
}: {
    points: ScatterPoint[];
    onSelect: (point: ScatterPoint) => void;
}) {
    const [hover, setHover] = useState<ScatterPoint | null>(null);
    const [providerFilter, setProviderFilter] = useState<IconProvider | "all">("all");

    const filtered = useMemo(
        () => (providerFilter === "all" ? points : points.filter((p) => p.provider === providerFilter)),
        [points, providerFilter]
    );

    const bounds = useMemo(() => {
        if (filtered.length === 0) {
            return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
        }
        const xs = filtered.map((p) => p.x);
        const ys = filtered.map((p) => p.y);
        return {
            minX: Math.min(...xs),
            maxX: Math.max(...xs),
            minY: Math.min(...ys),
            maxY: Math.max(...ys),
        };
    }, [filtered]);

    const width = 960;
    const height = 560;
    const pad = 28;

    const project = (point: ScatterPoint) => {
        const xSpan = bounds.maxX - bounds.minX || 1;
        const ySpan = bounds.maxY - bounds.minY || 1;
        return {
            cx: pad + ((point.x - bounds.minX) / xSpan) * (width - pad * 2),
            cy: height - pad - ((point.y - bounds.minY) / ySpan) * (height - pad * 2),
        };
    };

    const providers = Array.from(new Set(points.map((p) => p.provider)));

    return (
        <section className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 backdrop-blur">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h2 className="text-xl font-semibold">Embedding map</h2>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                        PCA projection of multimodal embeddings for mapped icons. Click a point to
                        inspect neighbors.
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={() => setProviderFilter("all")}
                        className={`rounded-lg px-3 py-1.5 text-xs ${
                            providerFilter === "all"
                                ? "bg-[var(--ink)] text-white"
                                : "bg-white/70 text-[var(--muted)]"
                        }`}
                    >
                        all
                    </button>
                    {providers.map((provider) => (
                        <button
                            key={provider}
                            type="button"
                            onClick={() => setProviderFilter(provider)}
                            className={`rounded-lg px-3 py-1.5 text-xs ${
                                providerFilter === provider
                                    ? "bg-[var(--ink)] text-white"
                                    : "bg-white/70 text-[var(--muted)]"
                            }`}
                        >
                            {provider}
                        </button>
                    ))}
                </div>
            </div>

            <div className="mt-4 overflow-auto rounded-xl bg-white/60">
                <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full min-w-[720px]">
                    <rect width={width} height={height} fill="transparent" />
                    {filtered.map((point) => {
                        const { cx, cy } = project(point);
                        const active = hover?.id === point.id;
                        return (
                            <circle
                                key={point.id}
                                cx={cx}
                                cy={cy}
                                r={active ? 7 : 4.5}
                                fill={point.color}
                                opacity={active ? 1 : 0.78}
                                className="cursor-pointer"
                                onMouseEnter={() => setHover(point)}
                                onMouseLeave={() => setHover(null)}
                                onClick={() => onSelect(point)}
                            >
                                <title>
                                    {point.provider}:{point.name} → {point.concept}
                                </title>
                            </circle>
                        );
                    })}
                </svg>
            </div>

            {hover && (
                <div className="mt-3 font-[var(--font-mono)] text-xs text-[var(--muted)]">
                    {hover.provider}:{hover.name} → {hover.concept}
                </div>
            )}
        </section>
    );
}
