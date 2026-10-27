import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowDown, ArrowRight, ArrowUpRight, Database, Layers3, Radio, Workflow } from "lucide-react";
import { Brand } from "../components/brand";

export const Route = createFileRoute("/")({ component: Home });

const features = [
    {
        number: "01",
        icon: Layers3,
        title: "Describe your domain.",
        text: "Object types, relationships, and actions in a portable ontology. One shared definition across your stack.",
    },
    {
        number: "02",
        icon: Database,
        title: "Keep data close.",
        text: "Query local data and apply optimistic actions. Storage and replication take care of the trip upstream.",
    },
    {
        number: "03",
        icon: Workflow,
        title: "Choose the pieces.",
        text: "Compose storage, provider adapters, and scoped runtimes with Effect. Inspect demand and sync in devtools.",
    },
];

function Home() {
    return (
        <div className="landing">
            <header className="site-header">
                <Link to="/" aria-label="Party Stack home">
                    <Brand />
                </Link>
                <nav aria-label="Main navigation">
                    <Link to="/docs/$" params={{ _splat: undefined }}>
                        Documentation
                    </Link>
                    <a href="https://github.com/robertf224/party-stack" className="github-link">
                        GitHub <ArrowUpRight size={14} />
                    </a>
                </nav>
            </header>

            <main>
                <section className="hero">
                    <div className="hero-copy">
                        <span className="eyebrow">
                            <span className="small-dot" /> A stack for connected applications
                        </span>
                        <h1>
                            Your data.
                            <br />
                            <span>Closer to home.</span>
                        </h1>
                        <p className="hero-description">
                            Build around your domain. Keep interactions local. Connect to the systems where
                            your data lives.
                        </p>
                        <div className="hero-actions">
                            <Link className="primary-link" to="/docs/$" params={{ _splat: undefined }}>
                                Explore the docs <ArrowRight size={16} />
                            </Link>
                            <Link className="secondary-link" to="/docs/$" params={{ _splat: "architecture" }}>
                                See the architecture <ArrowUpRight size={15} />
                            </Link>
                        </div>
                        <p className="hero-footnote">
                            TypeScript · Effect · TanStack DB <span>Early development</span>
                        </p>
                    </div>
                    <div
                        className="stack-diagram"
                        aria-label="Application queries a local replica, which syncs with a connected backend"
                    >
                        <div className="diagram-caption">
                            <Radio size={14} /> THE SAME DOMAIN, AT EVERY LAYER
                        </div>
                        <div className="diagram-card app-card">
                            <span className="diagram-label">YOUR APPLICATION</span>
                            <div className="issue-preview">
                                <span className="issue-checkbox">✓</span>
                                <span>Ship something good</span>
                                <span className="issue-state">Done</span>
                            </div>
                            <div className="preview-code">
                                <span>ontology</span>.objects.Issue
                            </div>
                        </div>
                        <div className="diagram-connection">
                            <ArrowDown size={15} />
                            <span>Query locally · act optimistically</span>
                        </div>
                        <div className="diagram-card replica-card">
                            <div className="diagram-card-heading">
                                <Database size={18} />
                                <strong>Local replica</strong>
                                <span className="local-badge">On your device</span>
                            </div>
                            <div className="replica-parts">
                                <span>Base rows</span>
                                <span>Outbox</span>
                                <span>Overlay</span>
                            </div>
                        </div>
                        <div className="diagram-connection">
                            <ArrowDown size={15} />
                            <span>Synchronize in the background</span>
                        </div>
                        <div className="diagram-card backend-card">
                            <span className="small-dot" />
                            <strong>Your backend</strong>
                            <span>Owned storage or provider adapter</span>
                        </div>
                    </div>
                </section>

                <div className="section-rule">
                    <span>DEFINITION → STORAGE → REPLICATION → APPLICATION</span>
                    <span>COMPOSE WHAT YOU NEED</span>
                </div>
                <section className="feature-grid" aria-label="Foundations">
                    {features.map(({ number, icon: Icon, title, text }) => (
                        <article key={number}>
                            <div className="feature-meta">
                                <span>{number}</span>
                                <Icon size={19} strokeWidth={1.5} />
                            </div>
                            <h2>{title}</h2>
                            <p>{text}</p>
                        </article>
                    ))}
                </section>
                <section className="docs-callout">
                    <div>
                        <p className="eyebrow">BUILDING IN THE OPEN</p>
                        <h2>Follow the architecture as it takes shape.</h2>
                        <p>Working concepts, real examples, and proposals you can inspect.</p>
                    </div>
                    <Link to="/docs/$" params={{ _splat: "design/replication" }}>
                        Read the replication proposal <ArrowRight size={16} />
                    </Link>
                </section>
            </main>
            <footer className="site-footer">
                <Brand />
                <span>Local interaction. Connected data.</span>
                <a href="https://github.com/robertf224/party-stack">Source ↗</a>
            </footer>
        </div>
    );
}
