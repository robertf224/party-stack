import { Combobox } from "@base-ui/react/combobox";
import { useEffect, useMemo, useState } from "react";
import type { CatalogFile, CatalogIcon, DraftMappingsFile, IconProvider } from "../shared/types";
import { IconTile } from "./IconTile";
import {
    createMappingFeedbackFile,
    loadMappingConfirmations,
    loadMappingFeedback,
    mappingFeedbackKey,
    saveMappingConfirmations,
    saveMappingFeedback,
    type MappingFeedbackFile,
    type MappingFeedback,
    type MappingFeedbackDecision,
} from "../shared/mappingFeedback";

const PROVIDER_LABEL: Record<IconProvider, string> = {
    blueprint: "Blueprint / Foundry",
    lucide: "Lucide",
    material: "Material Symbols",
    salesforce: "Salesforce",
    sfsymbols: "SF Symbols",
};

async function persistMappingFeedbackFile(file: MappingFeedbackFile): Promise<void> {
    const response = await fetch("/__save-mapping-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(file),
    });
    if (!response.ok) {
        throw new Error(await response.text());
    }
}

function ReplacementIconCombobox({
    icons,
    selectedName,
    onClear,
    onSelect,
}: {
    icons: CatalogIcon[];
    selectedName?: string;
    onClear: () => void;
    onSelect: (icon: CatalogIcon) => void;
}) {
    const [query, setQuery] = useState(selectedName ?? "");
    const selectedIcon = icons.find((icon) => icon.name === selectedName);
    const candidates = useMemo(() => {
        const normalized = query.trim().toLowerCase();
        return icons
            .filter(
                (icon) =>
                    !normalized ||
                    icon.name.toLowerCase().includes(normalized) ||
                    icon.labels.some((label) => label.toLowerCase().includes(normalized))
            )
            .slice(0, 12);
    }, [icons, query]);

    useEffect(() => {
        setQuery(selectedName ?? "");
    }, [selectedName]);

    return (
        <div className="mt-2">
            <Combobox.Root
                items={icons}
                filteredItems={candidates}
                value={selectedIcon ?? null}
                inputValue={query}
                itemToStringLabel={(icon) => icon.name}
                isItemEqualToValue={(left, right) => left.id === right.id}
                onInputValueChange={setQuery}
                onValueChange={(icon) => {
                    if (icon) {
                        setQuery(icon.name);
                        onSelect(icon);
                    } else {
                        setQuery("");
                        onClear();
                    }
                }}
            >
                <Combobox.InputGroup className="flex w-full min-w-0 overflow-hidden rounded-md border border-[var(--line)] bg-white focus-within:border-[var(--accent)]">
                    <Combobox.Input
                        aria-label="Replacement icon"
                        placeholder="Search replacement icons"
                        className="min-w-0 flex-1 border-0 bg-transparent px-2 py-1.5 text-[11px] outline-none"
                    />
                    <Combobox.Clear
                        aria-label="Clear replacement"
                        className="flex w-7 shrink-0 items-center justify-center bg-slate-100 text-xs text-slate-600"
                    >
                        ×
                    </Combobox.Clear>
                    <Combobox.Trigger
                        aria-label="Open replacement icons"
                        className="flex w-7 shrink-0 items-center justify-center bg-slate-50 text-xs text-slate-500"
                    >
                        ▾
                    </Combobox.Trigger>
                </Combobox.InputGroup>
                <Combobox.Portal>
                    <Combobox.Positioner align="start" sideOffset={4} className="z-50 outline-none">
                        <Combobox.Popup className="data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 w-[var(--anchor-width)] min-w-60 max-w-[var(--available-width)] origin-[var(--transform-origin)] rounded-lg border border-[var(--line)] bg-white shadow-xl transition-[transform,opacity] duration-100">
                            <Combobox.Empty className="p-2 text-[11px] text-[var(--muted)]">
                                No matching provider icons
                            </Combobox.Empty>
                            <Combobox.List className="max-h-[min(20rem,var(--available-height))] overflow-y-auto overscroll-contain p-1 outline-none">
                                {(candidate: CatalogIcon) => (
                                    <Combobox.Item
                                        key={candidate.id}
                                        value={candidate}
                                        className="data-highlighted:bg-slate-100 flex cursor-default items-center gap-2 rounded-md p-1.5 text-left outline-none"
                                    >
                                        <IconTile icon={candidate} size={24} />
                                        <span className="min-w-0 truncate text-[10px] font-[var(--font-mono)]">
                                            {candidate.name}
                                        </span>
                                    </Combobox.Item>
                                )}
                            </Combobox.List>
                        </Combobox.Popup>
                    </Combobox.Positioner>
                </Combobox.Portal>
            </Combobox.Root>
            {selectedIcon && (
                <div className="mt-2 flex items-center gap-2 rounded-lg bg-slate-50 p-2">
                    <IconTile icon={selectedIcon} size={28} />
                    <div className="min-w-0">
                        <div className="truncate text-[10px] font-[var(--font-mono)]">
                            {selectedIcon.name}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export function DraftMappingBrowser({ catalog, draft }: { catalog: CatalogFile; draft: DraftMappingsFile }) {
    const [query, setQuery] = useState("");
    const [show, setShow] = useState<"all" | "existing" | "generated">("all");
    const [review, setReview] = useState<"all" | "in-progress" | "confirmed">("all");
    const [selectedConcept, setSelectedConcept] = useState(draft.mappings[0]?.concept ?? "");
    const [feedback, setFeedback] = useState<MappingFeedback[]>(() => loadMappingFeedback());
    const [confirmedConcepts, setConfirmedConcepts] = useState<string[]>(() => loadMappingConfirmations());
    const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
    const iconById = useMemo(() => new Map(catalog.icons.map((icon) => [icon.id, icon])), [catalog.icons]);
    const iconsByProvider = useMemo(() => {
        const groups = new Map<IconProvider, CatalogIcon[]>();
        for (const provider of catalog.providers) {
            groups.set(
                provider,
                catalog.icons
                    .filter((icon) => icon.provider === provider)
                    .sort((left, right) => left.name.localeCompare(right.name))
            );
        }
        return groups;
    }, [catalog.icons, catalog.providers]);
    const confirmedSet = useMemo(() => new Set(confirmedConcepts), [confirmedConcepts]);
    const feedbackByKey = useMemo(
        () => new Map(feedback.map((item) => [mappingFeedbackKey(item.concept, item.provider), item])),
        [feedback]
    );
    const filtered = useMemo(() => {
        const normalized = query.trim().toLowerCase();
        return draft.mappings.filter(
            (mapping) =>
                (show === "all" || mapping.status === show) &&
                (review === "all" ||
                    (review === "confirmed"
                        ? confirmedSet.has(mapping.concept)
                        : !confirmedSet.has(mapping.concept))) &&
                (!normalized ||
                    mapping.concept.includes(normalized) ||
                    Object.values(mapping.providers).some((provider) =>
                        provider?.name.toLowerCase().includes(normalized)
                    ))
        );
    }, [confirmedSet, draft.mappings, query, review, show]);
    const selected = filtered.find((mapping) => mapping.concept === selectedConcept) ?? filtered[0];
    const selectedProviders = selected
        ? Object.entries(selected.providers).filter((entry) => Boolean(entry[1]))
        : [];
    const selectedAcceptedCount = selectedProviders.filter(([provider]) => {
        const decision = feedbackByKey.get(
            mappingFeedbackKey(selected!.concept, provider as IconProvider)
        )?.decision;
        return decision === "approve" || decision === "replace";
    }).length;
    const selectedConfirmed = selected ? confirmedSet.has(selected.concept) : false;
    const canConfirm = selectedProviders.length > 0 && selectedAcceptedCount === selectedProviders.length;

    useEffect(() => {
        const timeout = window.setTimeout(() => {
            setSaveStatus("saving");
            persistMappingFeedbackFile(createMappingFeedbackFile(feedback, undefined, confirmedConcepts))
                .then(() => setSaveStatus("saved"))
                .catch(() => setSaveStatus("error"));
        }, 300);
        return () => window.clearTimeout(timeout);
    }, [confirmedConcepts, feedback]);

    function updateConfirmedConcepts(next: string[]) {
        setConfirmedConcepts(next);
        saveMappingConfirmations(next);
        setSaveStatus("idle");
    }

    function unconfirmConcept(concept: string) {
        if (confirmedSet.has(concept)) {
            updateConfirmedConcepts(confirmedConcepts.filter((item) => item !== concept));
        }
    }

    function updateFeedback(
        concept: string,
        provider: IconProvider,
        currentName: string,
        update: Partial<Pick<MappingFeedback, "decision" | "replacementName" | "note">>
    ) {
        const key = mappingFeedbackKey(concept, provider);
        const existing = feedbackByKey.get(key);
        const nextItem: MappingFeedback = {
            concept,
            provider,
            currentName,
            decision: update.decision ?? existing?.decision ?? "approve",
            replacementName: "replacementName" in update ? update.replacementName : existing?.replacementName,
            note: "note" in update ? update.note : existing?.note,
            updatedAt: new Date().toISOString(),
        };
        const choiceChanged =
            nextItem.decision !== existing?.decision ||
            nextItem.replacementName !== existing?.replacementName;
        const next = [
            ...feedback.filter((item) => mappingFeedbackKey(item.concept, item.provider) !== key),
            nextItem,
        ];
        setFeedback(next);
        saveMappingFeedback(next);
        setSaveStatus("idle");
        if (choiceChanged) {
            unconfirmConcept(concept);
        }
    }

    function removeReplacementFeedback(concept: string, provider: IconProvider) {
        const key = mappingFeedbackKey(concept, provider);
        if (feedbackByKey.get(key)?.decision !== "replace") {
            return;
        }
        const next = feedback.filter((item) => mappingFeedbackKey(item.concept, item.provider) !== key);
        setFeedback(next);
        saveMappingFeedback(next);
        setSaveStatus("idle");
        unconfirmConcept(concept);
    }

    function exportFeedback() {
        const blob = new Blob(
            [JSON.stringify(createMappingFeedbackFile(feedback, undefined, confirmedConcepts), null, 2)],
            {
                type: "application/json",
            }
        );
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "icon-mapping-feedback.json";
        link.click();
        URL.revokeObjectURL(url);
    }

    async function saveFeedbackForAgent() {
        setSaveStatus("saving");
        try {
            await persistMappingFeedbackFile(
                createMappingFeedbackFile(feedback, undefined, confirmedConcepts)
            );
            setSaveStatus("saved");
        } catch {
            setSaveStatus("error");
        }
    }

    return (
        <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
            <aside className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-3 backdrop-blur">
                <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search 706 Blueprint concepts…"
                    className="w-full rounded-lg border border-[var(--line)] bg-white/80 px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                />
                <div className="my-3 flex gap-1">
                    {(["all", "generated", "existing"] as const).map((value) => (
                        <button
                            key={value}
                            type="button"
                            onClick={() => setShow(value)}
                            className={`rounded-md px-2 py-1 text-[11px] ${
                                show === value
                                    ? "bg-[var(--ink)] text-white"
                                    : "bg-white/70 text-[var(--muted)]"
                            }`}
                        >
                            {value}
                        </button>
                    ))}
                </div>
                <div className="mb-3 flex flex-wrap gap-1 border-t border-[var(--line)] pt-3">
                    {(["all", "in-progress", "confirmed"] as const).map((value) => (
                        <button
                            key={value}
                            type="button"
                            onClick={() => setReview(value)}
                            className={`rounded-md px-2 py-1 text-[11px] ${
                                review === value
                                    ? "bg-[var(--accent)] text-white"
                                    : "bg-white/70 text-[var(--muted)]"
                            }`}
                        >
                            {value === "all"
                                ? "all reviews"
                                : value === "in-progress"
                                  ? "in progress"
                                  : "confirmed"}
                        </button>
                    ))}
                </div>
                <div className="max-h-[68vh] space-y-1 overflow-auto pr-1">
                    {filtered.map((mapping) => {
                        const providers = Object.entries(mapping.providers).filter((entry) =>
                            Boolean(entry[1])
                        );
                        const accepted = providers.filter(([provider]) => {
                            const decision = feedbackByKey.get(
                                mappingFeedbackKey(mapping.concept, provider as IconProvider)
                            )?.decision;
                            return decision === "approve" || decision === "replace";
                        }).length;
                        const confirmed = confirmedSet.has(mapping.concept);
                        return (
                            <button
                                key={mapping.blueprintId}
                                type="button"
                                onClick={() => setSelectedConcept(mapping.concept)}
                                className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm ${
                                    selected?.blueprintId === mapping.blueprintId
                                        ? "bg-[var(--ink)] text-white"
                                        : "hover:bg-white/80"
                                }`}
                            >
                                <span className="truncate font-medium">{mapping.concept}</span>
                                <span
                                    className={`ml-2 shrink-0 text-[10px] font-[var(--font-mono)] ${
                                        selected?.blueprintId === mapping.blueprintId
                                            ? "text-white/70"
                                            : confirmed
                                              ? "text-[var(--good)]"
                                              : accepted > 0
                                                ? "text-[var(--warn)]"
                                                : "text-[var(--muted)]"
                                    }`}
                                >
                                    {confirmed ? "✓" : `${accepted}/${providers.length}`}
                                </span>
                            </button>
                        );
                    })}
                    {filtered.length === 0 && (
                        <div className="px-2 py-6 text-center text-xs text-[var(--muted)]">
                            No mappings in this view
                        </div>
                    )}
                </div>
            </aside>

            {selected && (
                <section className="min-w-0 space-y-4">
                    <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 backdrop-blur">
                        <div className="flex flex-wrap items-end justify-between gap-3">
                            <div>
                                <div className="flex items-center gap-2">
                                    <h2 className="text-2xl font-semibold tracking-tight">
                                        {selected.concept}
                                    </h2>
                                    <span
                                        className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                                            selected.status === "existing"
                                                ? "bg-emerald-100 text-emerald-800"
                                                : "bg-amber-100 text-amber-800"
                                        }`}
                                    >
                                        {selected.status}
                                    </span>
                                </div>
                                <p className="mt-1 text-sm text-[var(--muted)]">
                                    Blueprint-anchored mapping draft. Generated candidates blend CLIP
                                    image/name similarity with lexical overlap.
                                </p>
                            </div>
                            <div className="flex flex-col items-end gap-2">
                                <div className="text-xs font-[var(--font-mono)] text-[var(--muted)]">
                                    {selectedAcceptedCount}/{selectedProviders.length} accepted · min{" "}
                                    {selected.minScore.toFixed(3)} · mean {selected.meanScore.toFixed(3)}
                                </div>
                                <div className="flex flex-wrap items-center justify-end gap-2">
                                    <button
                                        type="button"
                                        disabled={!selectedConfirmed && !canConfirm}
                                        onClick={() =>
                                            updateConfirmedConcepts(
                                                selectedConfirmed
                                                    ? confirmedConcepts.filter(
                                                          (item) => item !== selected.concept
                                                      )
                                                    : [...confirmedConcepts, selected.concept]
                                            )
                                        }
                                        className={`rounded-lg px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
                                            selectedConfirmed
                                                ? "bg-emerald-600 text-white"
                                                : "bg-emerald-100 text-emerald-900"
                                        }`}
                                    >
                                        {selectedConfirmed ? "✓ Confirmed" : "Confirm mapping"}
                                    </button>
                                    <button
                                        type="button"
                                        disabled={feedback.length === 0 || saveStatus === "saving"}
                                        onClick={saveFeedbackForAgent}
                                        className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        {saveStatus === "saving" ? "Saving…" : "Save now"}
                                    </button>
                                    <button
                                        type="button"
                                        disabled={feedback.length === 0}
                                        onClick={exportFeedback}
                                        className="rounded-lg bg-[var(--ink)] px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        Download JSON
                                    </button>
                                </div>
                                <div
                                    className={`text-[10px] font-medium ${
                                        saveStatus === "error" ? "text-[var(--bad)]" : "text-[var(--muted)]"
                                    }`}
                                >
                                    {saveStatus === "saving"
                                        ? "Auto-saving…"
                                        : saveStatus === "error"
                                          ? "Auto-save failed · use Save now"
                                          : `Auto-saved in Cloud VM · ${feedback.length} decisions · ${confirmedConcepts.length} confirmed`}
                                </div>
                            </div>
                        </div>

                        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
                            {Object.entries(selected.providers).map(([provider, match]) => {
                                if (!match) {
                                    return null;
                                }
                                const icon = iconById.get(match.id);
                                if (!icon) {
                                    return null;
                                }
                                const providerName = provider as IconProvider;
                                const providerFeedback = feedbackByKey.get(
                                    mappingFeedbackKey(selected.concept, providerName)
                                );
                                const decisions: Array<{
                                    value: MappingFeedbackDecision;
                                    label: string;
                                }> = [
                                    { value: "approve", label: "Approve" },
                                    { value: "reject", label: "Reject" },
                                ];
                                return (
                                    <div
                                        key={provider}
                                        className="min-w-0 rounded-xl border border-[var(--line)] bg-white/70 p-3"
                                    >
                                        <div className="mb-2 text-[11px] uppercase tracking-wide text-[var(--muted)]">
                                            {PROVIDER_LABEL[provider as IconProvider]}
                                        </div>
                                        <IconTile icon={icon} size={56} />
                                        <div className="mt-3 break-all text-xs font-[var(--font-mono)]">
                                            {match.name}
                                        </div>
                                        <div className="mt-1 text-[11px] font-[var(--font-mono)] text-[var(--muted)]">
                                            anchor score {match.score.toFixed(3)}
                                        </div>
                                        {icon.textOnly && (
                                            <div className="mt-1 text-[10px] text-[var(--warn)]">
                                                local SF Symbol image missing; set SF_SYMBOLS_ASSET_DIR and
                                                regenerate
                                            </div>
                                        )}
                                        <div className="mt-3 border-t border-[var(--line)] pt-3">
                                            <div className="grid grid-cols-2 gap-1">
                                                {decisions.map(({ value, label }) => (
                                                    <button
                                                        key={value}
                                                        type="button"
                                                        onClick={() =>
                                                            updateFeedback(
                                                                selected.concept,
                                                                providerName,
                                                                match.name,
                                                                {
                                                                    decision: value,
                                                                    replacementName: undefined,
                                                                }
                                                            )
                                                        }
                                                        className={`w-full min-w-0 rounded-md px-1 py-1 text-[11px] ${
                                                            providerFeedback?.decision === value
                                                                ? value === "approve"
                                                                    ? "bg-emerald-600 text-white"
                                                                    : "bg-rose-600 text-white"
                                                                : "bg-slate-100 text-slate-600"
                                                        }`}
                                                    >
                                                        {label}
                                                    </button>
                                                ))}
                                            </div>
                                            <ReplacementIconCombobox
                                                icons={iconsByProvider.get(providerName) ?? []}
                                                selectedName={
                                                    providerFeedback?.decision === "replace"
                                                        ? providerFeedback.replacementName
                                                        : undefined
                                                }
                                                onClear={() =>
                                                    removeReplacementFeedback(selected.concept, providerName)
                                                }
                                                onSelect={(replacement) =>
                                                    updateFeedback(
                                                        selected.concept,
                                                        providerName,
                                                        match.name,
                                                        {
                                                            decision: "replace",
                                                            replacementName: replacement.name,
                                                        }
                                                    )
                                                }
                                            />
                                            <input
                                                aria-label={`Note for ${providerName}`}
                                                value={providerFeedback?.note ?? ""}
                                                disabled={!providerFeedback}
                                                onChange={(event) =>
                                                    updateFeedback(
                                                        selected.concept,
                                                        providerName,
                                                        match.name,
                                                        { note: event.target.value || undefined }
                                                    )
                                                }
                                                placeholder={
                                                    providerFeedback
                                                        ? "Optional note"
                                                        : "Choose a decision first"
                                                }
                                                className="mt-2 w-full rounded-md border border-[var(--line)] bg-white px-2 py-1.5 text-[11px] outline-none focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:bg-slate-100"
                                            />
                                            {providerFeedback && (
                                                <div className="mt-2 text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
                                                    recorded · {providerFeedback.decision}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 backdrop-blur">
                        <h3 className="text-sm font-semibold uppercase tracking-wide">Full-set coverage</h3>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
                            {catalog.providers.map((provider) => {
                                const archive = catalog.archives[provider];
                                return (
                                    <div key={provider} className="rounded-lg bg-white/65 p-3">
                                        <div className="text-xs font-medium">{PROVIDER_LABEL[provider]}</div>
                                        <div className="mt-1 text-[11px] font-[var(--font-mono)] text-[var(--muted)]">
                                            {archive?.iconCount.toLocaleString() ?? 0} icons
                                            {archive?.bytes
                                                ? ` · ${(archive.bytes / 1024).toFixed(0)} KiB zip`
                                                : " · names only"}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </section>
            )}
        </div>
    );
}
