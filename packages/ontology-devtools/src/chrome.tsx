import { PartyStackLogo, PartyStackLogomark } from "@party-stack/design-system/brand";

export interface OntologyDevtoolsChromeProps {
    theme: "light" | "dark";
}

export function OntologyDevtoolsPluginName({ theme }: OntologyDevtoolsChromeProps) {
    return (
        <div style={{ height: 30, width: 120 }}>
            <PartyStackLogo theme={theme} />
        </div>
    );
}

export function OntologyDevtoolsTrigger({ theme }: OntologyDevtoolsChromeProps) {
    const dark = theme === "dark";
    return (
        <div
            aria-label="Open Ontology devtools"
            style={{
                alignItems: "center",
                background: dark
                    ? "linear-gradient(145deg, #2d2d31, #171719)"
                    : "linear-gradient(145deg, #fff, #f5f5f4)",
                border: dark ? "1px solid rgba(255,255,255,.16)" : "1px solid rgba(23,23,23,.14)",
                borderRadius: "999px",
                boxSizing: "border-box",
                boxShadow: dark
                    ? "0 10px 30px rgba(0,0,0,.34), 0 0 0 4px rgba(141,120,235,.11)"
                    : "0 10px 28px rgba(28,25,23,.16), 0 0 0 4px rgba(141,120,235,.09)",
                cursor: "pointer",
                display: "flex",
                height: 48,
                justifyContent: "center",
                padding: 8,
                width: 48,
            }}
            title="Open Ontology devtools"
        >
            <PartyStackLogomark />
        </div>
    );
}

export function ontologyDevtoolsTrigger(_element: HTMLElement, { theme }: OntologyDevtoolsChromeProps) {
    return <OntologyDevtoolsTrigger theme={theme} />;
}
