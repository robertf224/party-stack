import { o } from "@party-stack/ontology-spec";
import { expect, test } from "vite-plus/test";
import { withObjectSources } from "./sources.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

test("source decoration follows nested schema paths and never mutates shared input handles", () => {
    const attachmentType = o.attachment({});
    const property = (name: string, type: import("@party-stack/ontology-spec").TypeDef) => ({
        name,
        displayName: name,
        type,
    });
    const objectType = {
        name: "Issue",
        primaryKey: "id",
        displayName: "Issue",
        pluralDisplayName: "Issues",
        properties: [
            property("id", o.string({})),
            property("first", attachmentType),
            property(
                "nested",
                o.list({ elementType: o.struct({ fields: [property("file", attachmentType)] }) })
            ),
        ],
    };
    const ir: OntologyIR = {
        types: [],
        linkTypes: [],
        actionTypes: [],
        queryFunctionTypes: [],
        objectTypes: [objectType],
    };
    const handle = { id: "shared" };
    const original = { id: "issue-1", first: handle, nested: [{ file: handle }] };
    const row = withObjectSources({ ir, objectType, object: original });
    expect(row).toEqual({
        id: "issue-1",
        first: { id: "shared", source: { objectType: "Issue", primaryKey: "issue-1", property: "first" } },
        nested: [
            {
                file: {
                    id: "shared",
                    source: { objectType: "Issue", primaryKey: "issue-1", property: "nested" },
                },
            },
        ],
    });
    expect(original.first).toEqual({ id: "shared" });
    expect(original.nested[0]!.file).toBe(handle);
    expect(withObjectSources({ ir, objectType, object: { ...original, id: "issue-2" } }).first).toMatchObject(
        { source: { primaryKey: "issue-2" } }
    );
    expect(row.first).toMatchObject({ source: { primaryKey: "issue-1" } });
});

test("encrypted sources use entity keys, remain opaque, and omit private device metadata", () => {
    const objectType = {
        name: "Issue",
        primaryKey: "id",
        displayName: "Issue",
        pluralDisplayName: "Issues",
        properties: [{ name: "secret", displayName: "Secret", type: o.encrypted({ type: o.string({}) }) }],
    };
    const ir: OntologyIR = {
        types: [],
        linkTypes: [],
        actionTypes: [],
        queryFunctionTypes: [],
        objectTypes: [objectType],
    };
    const cached = { ciphertext: "opaque", localCache: { ciphertext: "device" } };
    const row = withObjectSources({ ir, objectType, object: { secret: cached }, key: "issue" });
    expect(row).toEqual({
        secret: {
            ciphertext: "opaque",
            source: { objectType: "Issue", primaryKey: "issue", property: "secret" },
        },
    });
    expect(cached.localCache).toEqual({ ciphertext: "device" });
});
