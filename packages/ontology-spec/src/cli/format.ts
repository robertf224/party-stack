import { format } from "oxfmt";
import type { FormatConfig } from "oxfmt";

// Generator-owned style: consumer configuration must not change generated output.
const options: FormatConfig = {
    printWidth: 110,
    tabWidth: 4,
    singleQuote: false,
    semi: true,
    trailingComma: "es5",
    sortImports: false,
};

export async function formatGeneratedFile(filePath: string, content: string): Promise<string> {
    const result = await format(
        filePath,
        `// Auto-generated file - do not edit manually\n\n${content}`,
        options
    );
    if (result.errors.length > 0) {
        throw new Error(
            `Could not format generated file "${filePath}": ${result.errors.map((error) => error.message).join("; ")}`
        );
    }
    return result.code;
}
