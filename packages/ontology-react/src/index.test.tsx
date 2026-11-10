import { DbClient } from "@tanstack/db";
import { useDbClient } from "@tanstack/react-db";
import { Effect } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";
import { AuthenticationProvider } from "./authentication.js";
import { OntologyProvider, OntologyEnvironmentProvider, useOntology } from "./index.js";
import type { LiveOntology } from "@party-stack/ontology";

test("a borrowed ontology supplies the same client to query hooks without owning its lifetime", () => {
    const client = new DbClient();
    const ontology = { dbClient: client } as LiveOntology;
    function Child() {
        expect(useOntology()).toBe(ontology);
        expect(useDbClient()).toBe(client);
        return <span>Connected</span>;
    }
    expect(
        renderToStaticMarkup(
            <OntologyProvider ontology={ontology}>
                <Child />
            </OntologyProvider>
        )
    ).toBe("<span>Connected</span>");
});

test("server rendering construction props does not construct a replica", () => {
    expect(
        renderToStaticMarkup(
            <OntologyProvider
                ir={{ types: [], objectTypes: [], linkTypes: [], actionTypes: [], queryFunctionTypes: [] }}
                backend={Effect.sync(() => {
                    throw new Error("Server rendering must not acquire browser resources.");
                })}
            />
        )
    ).toBe("");
});

test("server rendering an environment opens neither transport nor selected views", () => {
    let opened = 0;
    const html = renderToStaticMarkup(
        <OntologyEnvironmentProvider
            client={Effect.sync(() => {
                opened++;
                return { ontology: () => Effect.die("SSR must not select a browser ontology.") };
            })}
        >
            <OntologyProvider ontology="connect" />
            <OntologyProvider ontology="issues" />
        </OntologyEnvironmentProvider>
    );
    expect(html).toBe("");
    expect(opened).toBe(0);
});

test("Connect setup does not open a command client or view during server rendering", () => {
    let selected = false;
    expect(
        renderToStaticMarkup(
            <OntologyEnvironmentProvider
                client={{
                    ontology: () => {
                        selected = true;
                        return Effect.die("SSR must not select Connect");
                    },
                }}
            >
                <AuthenticationProvider />
            </OntologyEnvironmentProvider>
        )
    ).toBe("");
    expect(selected).toBe(false);
});
