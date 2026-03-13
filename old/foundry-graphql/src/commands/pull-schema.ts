import fs from "fs/promises";
import path from "path";
import { ExecutableFoundrySchema } from "@bobbyfidz/foundry-graphql-schema";
import { performLocalOAuthFlow } from "@bobbyfidz/local-oauth-flow";
import env from "@next/env";
import { Command, Flags } from "@oclif/core";
import { createClient } from "@osdk/client";
import { printSchema } from "graphql";

env.loadEnvConfig(process.cwd(), true);

export default class PullSchema extends Command {
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
        output: Flags.string({ required: true, default: "schema.graphql" }),
    };

    public async run(): Promise<void> {
        try {
            const { flags } = await this.parse(PullSchema);
            const { accessToken } = await performLocalOAuthFlow({
                issuerUrl: flags.foundryUrl + "/multipass/api",
                authorizationUrl: flags.foundryUrl + "/multipass/api/oauth2/authorize",
                tokenUrl: flags.foundryUrl + "/multipass/api/oauth2/token",
                clientId: flags.foundryClientId,
                redirectUrl: flags.foundryRedirectUrl,
                scopes: ["api:read-data", "offline_access"],
            });
            const client = createClient(flags.foundryUrl, flags.foundryOntologyRid, () =>
                Promise.resolve(accessToken)
            );
            const { schema } = await ExecutableFoundrySchema.create(client);
            const schemaContent = printSchema(schema);
            await fs.writeFile(path.join(process.cwd(), flags.output), schemaContent);
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
