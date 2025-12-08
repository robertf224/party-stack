import fs from "fs/promises";
import path from "path";
import { performLocalOAuthFlow } from "@bobbyfidz/local-oauth-flow";
import env from "@next/env";
import { Command, Flags } from "@oclif/core";
import { OntologiesV2 } from "@osdk/foundry.ontologies";
import { createClient } from "../../utils/client.js";
import { generateObjectTypeSchemaFileContent } from "../generateObjectTypeSchemaFileContent.js";

env.loadEnvConfig(process.cwd(), true);

export default class Generate extends Command {
    static description = "write the current schema to a file";

    static flags = {
        foundryUrl: Flags.string({ required: true, default: getDefaultEnvValue("FOUNDRY_URL") }),
        foundryOntologyRid: Flags.string({
            required: true,
            default: getDefaultEnvValue("FOUNDRY_ONTOLOGY_RID"),
        }),
        foundryClientId: Flags.string({ required: true, default: getDefaultEnvValue("FOUNDRY_CLIENT_ID") }),
        foundryRedirectUrl: Flags.string({
            required: true,
            default: getDefaultEnvValue("FOUNDRY_REDIRECT_URL"),
        }),
        outputFolder: Flags.string({ required: true, default: "src/__generated__/foundry-db" }),
    };

    public async run(): Promise<void> {
        try {
            const { flags } = await this.parse(Generate);
            const { accessToken } = await performLocalOAuthFlow({
                issuerUrl: flags.foundryUrl + "/multipass/api",
                authorizationUrl: flags.foundryUrl + "/multipass/api/oauth2/authorize",
                tokenUrl: flags.foundryUrl + "/multipass/api/oauth2/token",
                clientId: flags.foundryClientId,
                redirectUrl: flags.foundryRedirectUrl,
                scopes: ["api:read-data", "offline_access"],
            });
            const client = createClient({
                baseUrl: flags.foundryUrl,
                tokenProvider: () => Promise.resolve(accessToken),
            });
            const ontology = await OntologiesV2.getFullMetadata(client, flags.foundryOntologyRid);

            // Create output directory if it doesn't exist
            const outputDir = path.join(process.cwd(), flags.outputFolder);
            await fs.mkdir(outputDir, { recursive: true });

            // Generate schema files for each object type
            const objectTypeNames: string[] = [];
            for (const objectType of Object.values(ontology.objectTypes)) {
                const apiName = objectType.objectType.apiName;
                const schemaContent = generateObjectTypeSchemaFileContent(objectType);
                const fileName = `${apiName}.ts`;
                await fs.writeFile(path.join(outputDir, fileName), schemaContent);
                objectTypeNames.push(apiName);
            }

            // Generate index.ts that re-exports all schemas
            const indexContent = objectTypeNames
                .map((name) => `export { ${name} } from "./${name}.js";`)
                .join("\n");
            await fs.writeFile(path.join(outputDir, "index.ts"), indexContent + "\n");
        } catch (error) {
            this.error(error instanceof Error ? error.message : String(error));
        }
    }
}

function getDefaultEnvValue(key: string): string | undefined {
    return (
        process.env[key] ??
        process.env[`NEXT_PUBLIC_${key}`] ??
        process.env[`VITE_PUBLIC_${key}`] ??
        process.env[`EXPO_PUBLIC_${key}`]
    );
}
