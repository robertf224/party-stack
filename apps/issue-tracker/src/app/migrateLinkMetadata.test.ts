import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import ontology from "../ontology/ontology";
import { migrateLinkMetadata } from "./migrateLinkMetadata";

test("the exact link correction preserves replica cursors, pending writes and stored rows, and is idempotent", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const position = Table.make<Record<string, unknown>>({
                    name: JSON.stringify(["replica", "example", "position"]),
                });
                const pending = Table.make<Record<string, unknown>>({
                    name: JSON.stringify(["replica", "example", "outbox"]),
                });
                const rows = Table.make<Record<string, unknown>>({
                    name: JSON.stringify(["replica", "example", "base:Issue"]),
                });
                const oldDefinition = {
                    ...ontology,
                    linkTypes: [
                        {
                            id: "ri.ontology.main.relation.0a932a4d-9f7d-4874-980c-ef326adbc825",
                            source: { objectType: "Project", name: "project", displayName: "Project" },
                            target: { objectType: "Issue", name: "issues", displayName: "Issue" },
                            foreignKey: "projectId",
                            cardinality: "one",
                        },
                    ],
                };
                const head = {
                    signature: JSON.stringify(oldDefinition),
                    source: "same-source",
                    sequence: 41,
                    cursor: "cursor-7",
                    parentClient: { id: "session" },
                };
                const action = { invocation: { id: "pending", name: "updateIssue" }, state: "queued" };
                const issue = { issueId: "issue", projectId: "project" };
                yield* tables.put(position, "head", head);
                yield* tables.put(pending, "pending", action);
                yield* tables.put(rows, "issue", issue);
                expect(yield* migrateLinkMetadata(tables, "example")).toBe(true);
                expect(yield* tables.get(position, "head")).toEqual({
                    ...head,
                    signature: JSON.stringify(ontology),
                });
                expect(yield* tables.get(pending, "pending")).toEqual(action);
                expect(yield* tables.get(rows, "issue")).toEqual(issue);
                expect(yield* migrateLinkMetadata(tables, "example")).toBe(false);
                yield* tables.put(position, "head", { ...head, signature: "unrelated-definition" });
                expect(yield* migrateLinkMetadata(tables, "example")).toBe(false);
                expect((yield* tables.get(position, "head"))?.signature).toBe("unrelated-definition");
                expect(yield* migrateLinkMetadata(tables, "new-namespace")).toBe(false);
            })
        )
    );
});
