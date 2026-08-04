import {
    cloudKitFieldNameForProperty,
    cloudKitOntologySchemaFields,
    cloudKitRecordTypeForObjectType,
    cloudKitSchemaTypeForOntologyType,
} from "./codec.js";
import type { OntologyIR } from "@party-stack/ontology";

function recordType(
    name: string,
    fields: Array<[string, string]>
): string {
    const declarations = [
        `"___recordID" REFERENCE QUERYABLE`,
        ...fields.map(([field, type]) => `${field} ${type}`),
        `GRANT WRITE TO "_creator"`,
        `GRANT CREATE TO "_icloud"`,
        `GRANT READ TO "_creator"`,
    ];
    return `    RECORD TYPE ${name} (\n${declarations
        .map((declaration) => `        ${declaration}`)
        .join(",\n")}\n    );`;
}

export function generateCloudKitSchema(ir: OntologyIR): string {
    const objectRecordTypes = ir.objectTypes.map((objectType) =>
        recordType(
            cloudKitRecordTypeForObjectType(objectType.name),
            objectType.properties.map((property) => [
                cloudKitFieldNameForProperty(property.name),
                cloudKitSchemaTypeForOntologyType(
                    ir,
                    property.type
                ),
            ])
        )
    );
    return [
        "DEFINE SCHEMA",
        ...objectRecordTypes,
        recordType("PS_PartyStackAttachment", [
            [
                cloudKitOntologySchemaFields.attachmentAsset,
                "ASSET",
            ],
            [
                cloudKitOntologySchemaFields
                    .attachmentContentType,
                "STRING",
            ],
            [
                cloudKitOntologySchemaFields.attachmentName,
                "STRING",
            ],
            [
                cloudKitOntologySchemaFields.attachmentSize,
                "INT64",
            ],
        ]),
        recordType("PS_PartyStackActionReceipt", [
            ["createdAt", "TIMESTAMP"],
        ]),
        "",
    ].join("\n\n");
}
