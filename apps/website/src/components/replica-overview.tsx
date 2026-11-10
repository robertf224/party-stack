import "./replica-overview.css";

function Objects({ overlay = false }: { overlay?: boolean }) {
    return (
        <div className={`replica-tree-objects${overlay ? " replica-tree-overlay" : ""}`} aria-hidden="true">
            <i />
            <i />
            <i />
            <i className="replica-tree-picture" />
        </div>
    );
}
function Replica({ name, tables, bytes }: { name: string; tables: string; bytes: string }) {
    return (
        <section className="replica-tree-actor" aria-label={`${name} replica`}>
            <header>
                <strong>{name}</strong>
                <small>{tables}</small>
            </header>
            <div className="replica-tree-store">
                <div>
                    <span>
                        Base state<small>Objects + attachment handles</small>
                    </span>
                    <Objects />
                </div>
                <div>
                    <span>Outbox</span>
                    <div className="replica-tree-actions" aria-label="Pending action entries">
                        <i />
                        <i />
                    </div>
                </div>
                <div>
                    <span>Speculative overlay</span>
                    <Objects overlay />
                </div>
            </div>
            <footer>
                <span>Attachment bytes</span>
                <span>{bytes}</span>
            </footer>
        </section>
    );
}
export function ReplicaOverview() {
    return (
        <figure
            className="replica-tree"
            aria-label="Replica hierarchy: owned backend, shared worker, and two browser tabs"
        >
            <div className="replica-tree-root">
                <section className="replica-tree-actor replica-tree-backend" aria-label="Owned backend">
                    <header>
                        <strong>Owned backend</strong>
                        <small>SQLite / PostgreSQL</small>
                    </header>
                    <div className="replica-tree-authority">
                        <span>Authoritative objects</span>
                        <Objects />
                    </div>
                    <div className="replica-tree-bookkeeping">Action receipts · Change journal</div>
                    <footer>
                        <span>Attachment bytes</span>
                        <span>Object storage</span>
                    </footer>
                </section>
            </div>
            <div className="replica-tree-trunk">
                <span>↑ Demand & actions</span>
                <i aria-hidden="true" />
                <span>State, results & bytes ↓</span>
            </div>
            <div className="replica-tree-owner">
                <Replica name="SharedWorker" tables="IndexedDB tables" bytes="OPFS" />
            </div>
            <div className="replica-tree-branches" aria-hidden="true">
                <i />
                <span />
                <span />
            </div>
            <div className="replica-tree-tabs">
                <Replica name="Your tab" tables="Memory tables" bytes="Memory" />
                <Replica name="Another tab" tables="Memory tables" bytes="Memory" />
            </div>
            <figcaption>
                Every replica keeps part of its parent’s state, an outbox of pending actions, and an overlay
                derived from those actions. Demand from apps and child replicas determines what it loads. Base
                state, outbox, and overlay share one transactional store; attachment bytes have their own
                local cache.
            </figcaption>
        </figure>
    );
}
