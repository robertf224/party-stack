import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { usePreferences } from "../preferences/context";
import { textError } from "./ui";

export type PanelSizes = { folders: number; notes: number };
const minimumFolders = 208;
const folderWidth = (value: number) => Math.max(minimumFolders, value);
const defaults: PanelSizes = { folders: 240, notes: 300 };
export function resizePanels(
    start: PanelSizes,
    pane: "folders" | "notes",
    delta: number,
    available: number
): PanelSizes {
    const maximum = Math.max(200, available - 320);
    if (pane === "folders")
        return {
            ...start,
            folders: folderWidth(Math.min(400, maximum - start.notes, start.folders + delta)),
        };
    const requested = start.notes + delta;
    if (requested >= 200)
        return {
            folders: start.folders,
            notes: Math.min(650, Math.max(0, maximum - start.folders), requested),
        };
    const overflow = 200 - requested;
    const folders = start.folders ? folderWidth(start.folders - overflow) : 0;
    return { folders, notes: 200 };
}
export function usePanels(reportError: (error: string) => void) {
    const preferences = usePreferences();
    const [foldersOpen, setFoldersOpen] = useState(true);
    const [notesOpen, setNotesOpen] = useState(true);
    const [draft, setDraft] = useState<PanelSizes>();
    const dragging = useRef(false);
    useEffect(() => {
        if (
            !dragging.current &&
            draft &&
            draft.folders === preferences.widths.folders &&
            draft.notes === preferences.widths.notes
        )
            setDraft(undefined);
    }, [draft, preferences.widths]);
    useEffect(
        () => () => {
            delete document.documentElement.dataset.resizing;
        },
        []
    );
    const widths = draft ?? preferences.widths;
    const sizes = { folders: foldersOpen ? widths.folders : 0, notes: notesOpen ? widths.notes : 0 };
    const save = (next: PanelSizes) => {
        const positive = {
            folders: Math.round(next.folders || widths.folders),
            notes: Math.round(next.notes || widths.notes),
        };
        setDraft(positive);
        void preferences.setWidths(positive).catch((error) => {
            setDraft(undefined);
            reportError(textError(error));
        });
    };
    const toggle = useCallback((pane: keyof PanelSizes) => {
        if (pane === "folders") setFoldersOpen((open) => !open);
        else setNotesOpen((open) => !open);
    }, []);
    const style = {
        "--folders-width": `${sizes.folders}px`,
        "--notes-width": `${sizes.notes}px`,
    } as CSSProperties;
    return {
        sizes,
        setSizes: (next: PanelSizes) =>
            setDraft({ folders: next.folders || widths.folders, notes: next.notes || widths.notes }),
        save,
        toggle,
        style,
        dragging,
    };
}

export function PaneDivider({
    pane,
    panels,
}: {
    pane: keyof PanelSizes;
    panels: ReturnType<typeof usePanels>;
}) {
    const drag = useRef<{ x: number; sizes: PanelSizes; width: number } | undefined>(undefined);
    return (
        <div
            className={`pane-divider ${pane}-divider`}
            role="separator"
            aria-label={pane === "folders" ? "Resize folders" : "Resize note list"}
            aria-orientation="vertical"
            aria-valuenow={Math.round(panels.sizes[pane])}
            aria-valuemin={0}
            aria-valuemax={pane === "folders" ? 400 : 650}
            tabIndex={0}
            onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                panels.dragging.current = true;
                document.documentElement.dataset.resizing = "true";
                drag.current = {
                    x: event.clientX,
                    sizes: panels.sizes,
                    width: event.currentTarget.parentElement!.clientWidth,
                };
            }}
            onPointerMove={(event) => {
                if (drag.current)
                    panels.setSizes(
                        resizePanels(
                            drag.current.sizes,
                            pane,
                            event.clientX - drag.current.x,
                            drag.current.width
                        )
                    );
            }}
            onPointerUp={(event) => {
                if (!drag.current) return;
                panels.dragging.current = false;
                delete document.documentElement.dataset.resizing;
                panels.save(
                    resizePanels(drag.current.sizes, pane, event.clientX - drag.current.x, drag.current.width)
                );
                drag.current = undefined;
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onLostPointerCapture={() => {
                panels.dragging.current = false;
                delete document.documentElement.dataset.resizing;
                drag.current = undefined;
            }}
            onDoubleClick={() => panels.save({ ...panels.sizes, [pane]: defaults[pane] })}
            onKeyDown={(event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    panels.toggle(pane);
                }
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault();
                    panels.save(
                        resizePanels(
                            panels.sizes,
                            pane,
                            (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 50 : 10),
                            event.currentTarget.parentElement!.clientWidth
                        )
                    );
                }
            }}
        />
    );
}
