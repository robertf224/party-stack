import { Table, type TablesService } from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import ontology from "../ontology/ontology";

const signature = JSON.stringify(ontology);
// Exact pre-fix definition: the Foundry importer had reversed the Issue/Project sides.
// Object schemas and action logic are identical, and this example has no relationship-traversing actions.
const previousSignature = JSON.stringify({
    ...ontology,
    linkTypes: ontology.linkTypes.map((link) =>
        link.id === "ri.ontology.main.relation.0a932a4d-9f7d-4874-980c-ef326adbc825"
            ? { ...link, source: link.target, target: link.source, cardinality: "one" }
            : link
    ),
});

/** One explicit example migration; unrelated definition/source changes still fail normal validation. */
export const migrateLinkMetadata = Effect.fn("IssueTracker.migrateLinkMetadata")(function* (
    tables: TablesService,
    namespace: string
) {
    const position = Table.make<{ signature: string } & Record<string, unknown>>({
        name: JSON.stringify(["replica", namespace, "position"]),
    });
    return yield* tables.transaction((tx) =>
        Effect.gen(function* () {
            const head = yield* tx.get(position, "head");
            if (head?.signature !== previousSignature) return false;
            yield* tx.put(position, "head", { ...head, signature });
            return true;
        })
    );
});
