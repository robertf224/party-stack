import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Dialog } from "@base-ui/react/dialog";
import { useLiveQuery } from "@tanstack/react-db";
import type { MetaLinkType } from "@party-stack/ontology";
import { useOntology } from "../ontology/OntologyProvider";

export function CommandBar() {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const { meta: metaOntology } = useOntology();
    const navigate = useNavigate();

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "k") {
                e.preventDefault();
                setOpen((prev) => !prev);
            }
            if (e.key === "Escape") {
                setOpen(false);
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, []);

    useEffect(() => {
        if (!open) {
            setSearch("");
            setSelectedIndex(0);
        }
    }, [open]);

    const { data: objectTypes } = useLiveQuery(
        (q) =>
            q
                .from({ ot: metaOntology.objects.ObjectType })
                .select(({ ot }) => ({
                    name: ot.name,
                    displayName: ot.displayName,
                })),
        [],
    );

    const { data: linkTypes } = useLiveQuery(
        (q) =>
            q
                .from({ lt: metaOntology.objects.LinkType })
                .select(({ lt }) => ({
                    id: lt.id,
                    sourceName: lt.source,
                    targetName: lt.target,
                })),
        [],
    );

    const results = useMemo(() => {
        const term = search.toLowerCase();
        const items: Array<{ label: string; sublabel: string; category: string; path: string }> = [];

        items.push({
            label: "Dashboard",
            sublabel: "Overview of all ontology types",
            category: "Navigation",
            path: "/",
        });

        for (const ot of objectTypes) {
            if (!term || ot.name.toLowerCase().includes(term) || ot.displayName.toLowerCase().includes(term)) {
                items.push({
                    label: ot.displayName,
                    sublabel: ot.name,
                    category: "Object Types",
                    path: `/object-types/${ot.name}`,
                });
            }
        }

        for (const lt of linkTypes) {
            const label = lt.id as string;
            if (!term || label.toLowerCase().includes(term)) {
                items.push({
                    label,
                    sublabel: `${(lt.sourceName as MetaLinkType["source"]).objectType} → ${(lt.targetName as MetaLinkType["target"]).objectType}`,
                    category: "Link Types",
                    path: `/link-types/${encodeURIComponent(lt.id as string)}`,
                });
            }
        }

        if (term) {
            return items.filter((item) => item.category !== "Navigation");
        }

        return items;
    }, [search, objectTypes, linkTypes]);

    useEffect(() => {
        setSelectedIndex(0);
    }, [results.length]);

    const handleSelect = (path: string) => {
        setOpen(false);
        void navigate({ to: path });
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelectedIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === "Enter" && results[selectedIndex]) {
            e.preventDefault();
            handleSelect(results[selectedIndex].path);
        }
    };

    const grouped = useMemo(() => {
        const groups = new Map<string, typeof results>();
        for (const item of results) {
            const group = groups.get(item.category) ?? [];
            group.push(item);
            groups.set(item.category, group);
        }
        return groups;
    }, [results]);

    let runningIndex = 0;

    return (
        <Dialog.Root open={open} onOpenChange={setOpen}>
            <Dialog.Portal>
                <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
                <Dialog.Popup className="animate-fade-in fixed top-[20%] left-1/2 z-50 w-[min(560px,90vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
                    <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
                        <svg
                            className="h-4 w-4 shrink-0 text-zinc-500"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <circle cx="11" cy="11" r="8" />
                            <path d="m21 21-4.3-4.3" />
                        </svg>
                        <input
                            autoFocus
                            className="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                            placeholder="Search object types, actions, links..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            onKeyDown={handleKeyDown}
                        />
                        <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                            ESC
                        </kbd>
                    </div>
                    <div className="max-h-[320px] overflow-y-auto p-2">
                        {results.length === 0 && (
                            <div className="px-3 py-6 text-center text-sm text-zinc-500">No results found</div>
                        )}
                        {Array.from(grouped.entries()).map(([category, items]) => (
                            <div key={category}>
                                <div className="px-3 py-1.5 text-[11px] font-medium tracking-wider text-zinc-500 uppercase">
                                    {category}
                                </div>
                                {items.map((item) => {
                                    const idx = runningIndex++;
                                    return (
                                        <button
                                            key={item.path}
                                            type="button"
                                            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                                                idx === selectedIndex
                                                    ? "bg-zinc-800 text-zinc-100"
                                                    : "text-zinc-300 hover:bg-zinc-800/60"
                                            }`}
                                            onClick={() => handleSelect(item.path)}
                                            onMouseEnter={() => setSelectedIndex(idx)}
                                        >
                                            <span className="truncate font-medium">{item.label}</span>
                                            <span className="truncate text-xs text-zinc-500">{item.sublabel}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                </Dialog.Popup>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
