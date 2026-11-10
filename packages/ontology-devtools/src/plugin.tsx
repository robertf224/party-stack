import { PartyStackLogomark } from "@party-stack/design-system/brand";
import { createReactPlugin } from "@tanstack/devtools-utils/react";
import { Component, lazy, Suspense, type ReactNode } from "react";
import { OntologyDevtoolsPluginName } from "./chrome.js";
import type { OntologyDevtoolsPanelProps, OntologyDevtoolsPluginOptions } from "./types.js";
import type { OntologyDefinition } from "@party-stack/ontology";
import type { TanStackDevtoolsReactPlugin } from "@tanstack/react-devtools";

const loadPanel = () => import("./OntologyDevtools.js");
const Panel = lazy(() => loadPanel().then((module) => ({ default: module.OntologyDevtoolsPanel })));

/** Warm optional inspector code after the application's first data is displayed, for offline use. */
export const preloadOntologyDevtools = () => loadPanel().then(() => undefined);

class InspectorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() {
        return { failed: true };
    }
    render() {
        return this.state.failed ? (
            <p>The inspector could not load. Reconnect and reload to try again.</p>
        ) : (
            this.props.children
        );
    }
}

/** Loading the shell must not import inspectors, schema layout or collection subscriptions. */
export function OntologyDevtoolsPanel<
    Ontology extends OntologyDefinition,
    MetaOntology extends OntologyDefinition = OntologyDefinition,
>(props: OntologyDevtoolsPanelProps<Ontology, MetaOntology>) {
    return (
        <InspectorBoundary>
            <Suspense
                fallback={
                    <div
                        role="status"
                        aria-label="Loading inspector"
                        style={{ height: "100%", minHeight: 160, display: "grid", placeItems: "center" }}
                    >
                        <div style={{ width: 44, height: 44 }}>
                            <PartyStackLogomark />
                        </div>
                    </div>
                }
            >
                <Panel {...props} />
            </Suspense>
        </InspectorBoundary>
    );
}

export function createOntologyDevtoolsPlugin<
    Ontology extends OntologyDefinition,
    MetaOntology extends OntologyDefinition = OntologyDefinition,
>({
    ontology,
    id = "party-stack-ontology",
    metaOntology,
    name,
    defaultOpen,
}: OntologyDevtoolsPluginOptions<Ontology, MetaOntology>): TanStackDevtoolsReactPlugin {
    const [createPlugin] = createReactPlugin({
        id,
        name: "Ontology",
        defaultOpen,
        Component: ({ theme, devtoolsOpen }) =>
            devtoolsOpen ? (
                <OntologyDevtoolsPanel metaOntology={metaOntology} ontology={ontology} theme={theme} />
            ) : (
                <></>
            ),
    });
    return {
        ...createPlugin(),
        name: name ?? ((_element, { theme }) => <OntologyDevtoolsPluginName theme={theme} />),
    };
}
