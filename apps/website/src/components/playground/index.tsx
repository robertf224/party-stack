import { lazy, Suspense, useState } from "react";
const Demo = lazy(() => import("./Demo"));

export function Playground() {
    const [started, setStarted] = useState(false);
    return (
        <section className="home-section playground" id="playground" aria-labelledby="playground-title">
            <p className="home-kicker">Try it here</p>
            <h2 id="playground-title">A little party of your own.</h2>
            <p className="home-section-intro">Change the query. Add a todo. Watch the replicas catch up.</p>
            {started ? (
                <Suspense fallback={<p className="demo-loading">Opening playground…</p>}>
                    <Demo />
                </Suspense>
            ) : (
                <button type="button" className="demo-start" onClick={() => setStarted(true)}>
                    Open the playground →
                </button>
            )}
        </section>
    );
}
