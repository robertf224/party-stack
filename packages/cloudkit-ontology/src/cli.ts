#!/usr/bin/env node

import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

interface SetupOptions {
    teamId?: string;
    containerId?: string;
    schema?: string;
    environment: "development" | "production";
    saveToken: boolean;
}

function parseArgs(args: string[]): SetupOptions {
    const result: SetupOptions = {
        environment: "development",
        saveToken: false,
    };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        switch (argument) {
            case "--team-id":
                result.teamId = args[++index];
                break;
            case "--container-id":
                result.containerId = args[++index];
                break;
            case "--schema":
                result.schema = args[++index];
                break;
            case "--environment": {
                const value = args[++index];
                if (
                    value !== "development" &&
                    value !== "production"
                ) {
                    throw new Error(
                        "CloudKit environment must be development or production."
                    );
                }
                result.environment = value;
                break;
            }
            case "--save-token":
                result.saveToken = true;
                break;
            case "--help":
            case "-h":
                printHelp();
                process.exit(0);
            default:
                if (argument !== "setup") {
                    throw new Error(
                        `Unknown argument "${argument}".`
                    );
                }
        }
    }
    return result;
}

function printHelp(): void {
    console.log(`Usage: cloudkit-ontology setup [options]

Interactively validate and import a Party Stack CloudKit schema.

Options:
  --team-id <id>          Apple Developer team ID
  --container-id <id>     iCloud container identifier
  --schema <path>         Generated .ckdb schema path
  --environment <value>   development (default) or production
  --save-token            Prompt to save a management token in Keychain
  -h, --help              Show this help
`);
}

function runCktool(args: string[]): void {
    const result = spawnSync("xcrun", ["cktool", ...args], {
        stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(
            `cktool ${args[0]} failed with exit code ${result.status ?? "unknown"}.`
        );
    }
}

async function promptForMissing(
    options: SetupOptions
): Promise<Required<Omit<SetupOptions, "saveToken">> & {
    saveToken: boolean;
}> {
    const terminal = createInterface({ input: stdin, output: stdout });
    try {
        const teamId =
            options.teamId ??
            (await terminal.question("Apple Developer team ID: "));
        const containerId =
            options.containerId ??
            (await terminal.question(
                "iCloud container ID (iCloud.…): "
            ));
        const schema =
            options.schema ??
            (await terminal.question("Path to .ckdb schema: "));
        let saveToken = options.saveToken;
        if (!saveToken) {
            const answer = await terminal.question(
                "Save/paste a CloudKit management token now? [y/N] "
            );
            saveToken = /^y(es)?$/i.test(answer.trim());
        }
        return {
            teamId: teamId.trim(),
            containerId: containerId.trim(),
            schema: schema.trim(),
            environment: options.environment,
            saveToken,
        };
    } finally {
        terminal.close();
    }
}

async function main(): Promise<void> {
    const options = await promptForMissing(
        parseArgs(process.argv.slice(2))
    );
    if (
        !options.teamId ||
        !options.containerId ||
        !options.schema
    ) {
        throw new Error(
            "Team ID, container ID, and schema path are required."
        );
    }
    await access(options.schema);

    console.log("\nCloudKit setup preflight");
    console.log(`  Team: ${options.teamId}`);
    console.log(`  Container: ${options.containerId}`);
    console.log(`  Environment: ${options.environment}`);
    console.log(`  Schema: ${options.schema}\n`);

    if (options.saveToken) {
        console.log(
            "Create a management token in CloudKit Console, then paste it into the secure prompt."
        );
        console.log(
            "https://icloud.developer.apple.com/dashboard/"
        );
        runCktool([
            "save-token",
            "--type",
            "management",
            "--method",
            "keychain",
        ]);
    }

    runCktool([
        "validate-schema",
        "--team-id",
        options.teamId,
        "--container-id",
        options.containerId,
        "--environment",
        options.environment,
        "--file",
        options.schema,
    ]);

    if (options.environment === "production") {
        console.log(
            "\nSchema validated. This setup command does not import directly into production."
        );
        return;
    }

    const terminal = createInterface({ input: stdin, output: stdout });
    let shouldImport = false;
    try {
        const answer = await terminal.question(
            "\nImport this schema into the development environment? [y/N] "
        );
        shouldImport = /^y(es)?$/i.test(answer.trim());
    } finally {
        terminal.close();
    }
    if (!shouldImport) {
        console.log("Schema import skipped.");
        return;
    }

    runCktool([
        "import-schema",
        "--team-id",
        options.teamId,
        "--container-id",
        options.containerId,
        "--environment",
        "development",
        "--validate",
        "--file",
        options.schema,
    ]);
    console.log("\nCloudKit development schema imported.");
    console.log(
        "For web access, create an API token and allowed origins in CloudKit Console."
    );
}

void main().catch((error: unknown) => {
    console.error(
        error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
});
