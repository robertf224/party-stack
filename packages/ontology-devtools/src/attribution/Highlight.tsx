import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePanelPortal } from "../PanelBoundary.js";
import type { DemandOwner } from "./registry.js";

export function ownerElements(owners: readonly DemandOwner[], root: ParentNode = document): HTMLElement[] {
    const ids = new Set(owners.map((owner) => owner.id));
    const panels = [...root.querySelectorAll("[data-ps-devtools]")];
    const candidates = [...root.querySelectorAll<HTMLElement>("[data-ps-demand-owner]")].filter(
        (element) =>
            ids.has(element.dataset.psDemandOwner ?? "") &&
            !element.closest("[data-ps-devtools]") &&
            !panels.some((panel) => element.contains(panel))
    );
    const selected = new Set(candidates);
    return candidates.filter((element) => {
        for (let parent = element.parentElement; parent; parent = parent.parentElement)
            if (selected.has(parent)) return false;
        return true;
    });
}
export function revealDemandOwners(owners: readonly DemandOwner[]) {
    const elements = ownerElements(owners);
    const target =
        elements.find((element) => {
            const rect = element.getBoundingClientRect();
            return rect.bottom < 0 || rect.top > window.innerHeight;
        }) ?? elements[0];
    target?.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
}
interface Box {
    id: string;
    name: string;
    left: number;
    top: number;
    width: number;
    height: number;
}
export function DemandHighlight({ owners }: { owners: readonly DemandOwner[] }) {
    const portal = usePanelPortal();
    const [boxes, setBoxes] = useState<readonly Box[]>([]);
    useEffect(() => {
        if (!owners.length) return;
        let frame: number;
        const measure = () => {
            const next = ownerElements(owners).flatMap((element, index) => {
                const rect = element.getBoundingClientRect();
                if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= window.innerHeight)
                    return [];
                return [
                    {
                        id: `${element.dataset.psDemandOwner}:${index}`,
                        name: owners.find((owner) => owner.id === element.dataset.psDemandOwner)!.name,
                        left: rect.left,
                        top: rect.top,
                        width: rect.width,
                        height: rect.height,
                    },
                ];
            });
            setBoxes((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
            frame = requestAnimationFrame(measure);
        };
        frame = requestAnimationFrame(measure);
        return () => cancelAnimationFrame(frame);
    }, [owners]);
    if (!owners.length || typeof document === "undefined") return null;
    return createPortal(
        <div className="ps-demand-highlights" data-ps-demand-highlights aria-hidden>
            {boxes.map((box) => (
                <div
                    className="ps-demand-highlight"
                    key={box.id}
                    data-owner-id={box.id}
                    style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
                >
                    <span>{box.name}</span>
                </div>
            ))}
        </div>,
        portal ?? document.body
    );
}
