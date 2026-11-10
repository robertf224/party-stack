import { useRouterState } from "@tanstack/react-router";
import { addTransitionType, startTransition, useCallback, useRef, useState, type ReactNode } from "react";
import { BootContext } from "./bootContext";
import { Splash, VisibleViewTransition } from "./ui";

/** Keep one splash through provider acquisition and the initial query reads. */
export function BootBoundary({ children }: { children: ReactNode }) {
    const [ready, setReady] = useState(false);
    const parts = useRef(new Set<string>());
    const finished = useRef(false);
    const needsEditor = useRouterState({
        select: (state) =>
            state.matches.some(
                (match) => "noteId" in match.params && typeof match.params.noteId === "string"
            ),
    });
    const loaded = useCallback(
        (part: string) => {
            if (finished.current) return;
            parts.current.add(part);
            if (parts.current.has("list") && (!needsEditor || parts.current.has("editor"))) {
                finished.current = true;
                startTransition(() => {
                    addTransitionType("notes-startup");
                    setReady(true);
                });
            }
        },
        [needsEditor]
    );
    return (
        <BootContext value={{ ready, loaded }}>
            {!ready && <Splash />}
            <VisibleViewTransition
                duringStartup
                default="none"
                update={{ "notes-startup": "notes-fade", default: "none" }}
            >
                <div
                    className="boot-workspace"
                    style={{ visibility: ready ? "visible" : "hidden" }}
                    inert={!ready}
                >
                    {children}
                </div>
            </VisibleViewTransition>
        </BootContext>
    );
}
