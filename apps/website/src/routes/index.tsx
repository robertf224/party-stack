import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { HomeSections } from "../components/home-sections";
import { HomeShader } from "../components/home-shader";
import { Playground } from "../components/playground";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
    return (
        <main className="home">
            <section className="home-hero">
                <div className="home-copy">
                    <h1>
                        Enjoy the party.
                        <br />
                        <span>We’ll mind the details.</span>
                    </h1>
                    <p>
                        Live queries, offline sync, optimistic actions, files, authentication, and
                        authorization. One TypeScript framework, from your UI to your backend.
                    </p>
                    <div className="home-actions">
                        <Link className="home-primary" to="/docs/$" params={{ _splat: "getting-started" }}>
                            Get started <ArrowRight size={16} />
                        </Link>
                        <Link className="home-secondary" to="/docs/$" params={{ _splat: "architecture" }}>
                            How it works
                        </Link>
                    </div>
                </div>
                <HomeShader />
            </section>
            <HomeSections />
            <Playground />
        </main>
    );
}
