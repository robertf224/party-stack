import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./styles.css?inline";

const PanelPortal = createContext<HTMLElement | null>(null);
export const usePanelPortal = () => useContext(PanelPortal);

interface Roots {
    panel: ShadowRoot;
    overlays: HTMLElement;
}

/** Keep panel and overlay styles private, while overlays can escape the shell's clipping. */
export function PanelBoundary({ children, theme }: { children: ReactNode; theme: "light" | "dark" }) {
    const host = useRef<HTMLDivElement>(null);
    const overlayElement = useRef<HTMLElement | null>(null);
    const [roots, setRoots] = useState<Roots>();
    useLayoutEffect(() => {
        const element = host.current!;
        const document = element.ownerDocument;
        const panel = element.shadowRoot ?? element.attachShadow({ mode: "open" });
        const panelStyle = document.createElement("style");
        panelStyle.textContent = styles;
        panel.append(panelStyle);

        const overlayHost = document.createElement("div");
        overlayHost.dataset.psDevtools = "overlays";
        overlayHost.style.cssText = "all: initial; display: contents;";
        const overlayRoot = overlayHost.attachShadow({ mode: "open" });
        const overlayStyle = document.createElement("style");
        overlayStyle.textContent = styles;
        const overlays = document.createElement("div");
        overlays.style.cssText =
            "all: initial; display: contents; font: 13px/1.5 Inter, ui-sans-serif, system-ui, sans-serif;";
        overlayRoot.append(overlayStyle, overlays);
        document.body.append(overlayHost);
        overlayElement.current = overlays;
        setRoots({ panel, overlays });
        return () => {
            panelStyle.remove();
            overlayHost.remove();
            overlayElement.current = null;
        };
    }, []);
    useLayoutEffect(() => {
        const overlays = overlayElement.current;
        if (!overlays) return;
        overlays.className = `ps-devtools ps-theme-${theme}`;
        overlays.style.colorScheme = theme;
    }, [roots, theme]);
    return (
        <div
            data-ps-devtools="panel"
            ref={host}
            style={{
                all: "initial",
                display: "block",
                width: "100%",
                height: "100%",
                minHeight: 0,
                colorScheme: theme,
            }}
        >
            {roots &&
                createPortal(
                    <PanelPortal.Provider value={roots.overlays}>{children}</PanelPortal.Provider>,
                    roots.panel
                )}
        </div>
    );
}
