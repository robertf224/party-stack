import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateCloudKitSchema } from "@party-stack/cloudkit-ontology";
import { journalOntology } from "../src/ontology.js";

const output = resolve(process.cwd(), "cloudkit-schema.ckdb");
await writeFile(output, generateCloudKitSchema(journalOntology));
console.log(`Wrote ${output}`);
