import { expect, test } from "vite-plus/test";
import { objectTypesWithAttachments } from "./attachmentCapability.js";
import type { OntologyIR, TypeDef } from "@party-stack/ontology-spec";

const text: TypeDef = { kind: "string", value: {} };
const attachment: TypeDef = { kind: "attachment", value: {} };
const ref = (name: string): TypeDef => ({ kind: "ref", value: { name } });
function ir(objects: Record<string, TypeDef>, definitions: Record<string, TypeDef> = {}): OntologyIR {
    return {
        types: Object.entries(definitions).map(([name, type]) => ({ name, type })),
        objectTypes: Object.entries(objects).map(([name, type]) => ({
            name,
            displayName: name,
            pluralDisplayName: name,
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: text },
                { name: "value", displayName: "Value", type },
            ],
        })),
        linkTypes: [],
        actionTypes: [],
        queryFunctionTypes: [],
    };
}

test("finds declared attachments through each supported container and named type", () => {
    const cases: Record<string, TypeDef> = {
        Direct: attachment,
        Named: ref("File"),
        Optional: { kind: "optional", value: { type: ref("File") } },
        List: { kind: "list", value: { elementType: attachment } },
        Map: { kind: "map", value: { keyType: text, valueType: attachment } },
        Struct: {
            kind: "struct",
            value: { fields: [{ name: "file", displayName: "File", type: attachment }] },
        },
        Union: {
            kind: "union",
            value: {
                variants: [
                    { name: "empty", type: text },
                    { name: "file", type: attachment },
                ],
            },
        },
        ResultOK: { kind: "result", value: { okType: attachment, errType: text } },
        ResultError: { kind: "result", value: { okType: text, errType: attachment } },
    };
    expect([...objectTypesWithAttachments(ir(cases, { File: attachment }))].sort()).toEqual(
        Object.keys(cases).sort()
    );
});

test("does not follow encrypted plaintext, object-reference targets, or unknown values", () => {
    expect([
        ...objectTypesWithAttachments(
            ir({
                Encrypted: { kind: "encrypted", value: { type: attachment } },
                Reference: { kind: "objectReference", value: { objectType: "File" } },
                Unknown: { kind: "unknown", value: {} },
                Plain: text,
                File: attachment,
            })
        ),
    ]).toEqual(["File"]);
});

test("terminates recursive aliases while still finding an attachment on another graph branch", () => {
    const definitions: Record<string, TypeDef> = {
        A: {
            kind: "union",
            value: {
                variants: [
                    { name: "next", type: ref("B") },
                    { name: "file", type: ref("File") },
                ],
            },
        },
        B: { kind: "list", value: { elementType: ref("A") } },
        File: attachment,
        NoFilesA: { kind: "list", value: { elementType: ref("NoFilesB") } },
        NoFilesB: { kind: "optional", value: { type: ref("NoFilesA") } },
        AliasA: ref("AliasB"),
        AliasB: ref("AliasA"),
    };
    expect([
        ...objectTypesWithAttachments(
            ir(
                {
                    StartsA: ref("A"),
                    StartsB: ref("B"),
                    RecursivePlain: ref("NoFilesA"),
                    AliasCycle: ref("AliasA"),
                },
                definitions
            )
        ),
    ]).toEqual(["StartsA", "StartsB"]);
});

test("a missing named type conservatively disables the optimization", () => {
    expect([...objectTypesWithAttachments(ir({ Invalid: ref("Missing") }))]).toEqual(["Invalid"]);
});
