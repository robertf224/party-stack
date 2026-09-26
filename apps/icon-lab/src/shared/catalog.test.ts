import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { SalesforceLightningIconNames } from "@party-stack/icons-salesforce-lightning";

const appRoot = path.resolve(import.meta.dirname, "../..");

describe("generated full icon catalog", () => {
    it("contains complete provider sets in compact archives", async () => {
        const minimums = {
            blueprint: 700,
            lucide: 2_000,
            material: 16_000,
            salesforce: 1_700,
        } as const;
        for (const provider of Object.keys(minimums) as Array<keyof typeof minimums>) {
            const zip = unzipSync(
                new Uint8Array(
                    await readFile(path.join(appRoot, `public/icon-sets/${provider}.zip`))
                )
            );
            expect(Object.keys(zip).length).toBeGreaterThanOrEqual(minimums[provider]);
        }
        const sfSymbolNames = JSON.parse(
            await readFile(
                path.join(appRoot, "public/icon-sets/sfsymbols.json"),
                "utf8"
            )
        ) as string[];
        expect(sfSymbolNames.length).toBeGreaterThanOrEqual(9_000);
    });

    it("includes the Salesforce plane glyph and maps airplane to it", async () => {
        const zip = unzipSync(
            new Uint8Array(
                await readFile(path.join(appRoot, "public/icon-sets/salesforce.zip"))
            )
        );
        expect(zip["utility/plane.svg"]).toBeDefined();
        expect(SalesforceLightningIconNames.airplane).toBe("utility/plane");
    });
});
