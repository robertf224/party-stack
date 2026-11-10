import { o, validate, type OntologyIR } from "@party-stack/ontology-spec";
import { expect, test } from "vite-plus/test";
import definition from "./ontology";
import { transformPulledOntology } from "./transformPulledOntology";

test("the app transform constrains issue images without losing Foundry metadata or mutating the pull", () => {
    const pulled: OntologyIR = structuredClone(definition);
    pulled.objectTypes = pulled.objectTypes.filter((type) => type.name !== "User");
    const unconstrained = o.optional({
        type: o.list({ elementType: o.attachment({ meta: { foundry: { kind: "attachment" } } }) }),
    });
    pulled.objectTypes
        .find((type) => type.name === "Issue")!
        .properties.find((property) => property.name === "issueAttachments")!.type = unconstrained;
    for (const name of ["createIssue", "updateIssue"]) {
        pulled.actionTypes
            .find((type) => type.name === name)!
            .parameters.find((parameter) => parameter.name === "attachments")!.type = unconstrained;
    }
    const before = structuredClone(pulled);
    const transformed = transformPulledOntology(pulled);
    const expected = o.optional({
        type: o.list({
            elementType: o.attachment({
                meta: { foundry: { kind: "attachment" } },
                constraint: {
                    content: o.AttachmentContentConstraint.image({ mediaTypes: ["image/png", "image/jpeg"] }),
                },
            }),
        }),
    });
    expect(
        transformed.objectTypes
            .find((type) => type.name === "Issue")!
            .properties.find((property) => property.name === "issueAttachments")!.type
    ).toEqual(expected);
    for (const name of ["createIssue", "updateIssue"]) {
        expect(
            transformed.actionTypes
                .find((type) => type.name === name)!
                .parameters.find((parameter) => parameter.name === "attachments")!.type
        ).toEqual(expected);
    }
    expect(pulled).toEqual(before);
    expect(transformed.context).toEqual(pulled.context);
    expect(validate(transformed).kind).toBe("ok");
    expect(transformPulledOntology(transformed)).toEqual(transformed);
});

test("the app transform adds the user context when absent and reports removed attachment fields", () => {
    const pulled: OntologyIR = { ...definition, context: undefined };
    expect(transformPulledOntology(pulled).context).toMatchObject({
        type: { kind: "struct", value: { fields: [{ name: "userId" }] } },
        partition: [["userId"]],
    });
    expect(() => transformPulledOntology({ ...pulled, actionTypes: [] })).toThrow("createIssue.attachments");
});
