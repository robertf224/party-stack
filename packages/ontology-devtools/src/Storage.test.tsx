import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";
import { StorageDetails } from "./Storage.js";

test("the same per-type chart uses schema colors with optional capacity and configured budgets", () => {
    const status = {
        cache: {
            objects: {
                bytes: 2048,
                byObjectType: [{ objectType: "Issue", bytes: 2048 }],
                maxBytes: 1024,
                targetBytes: 512,
            },
            attachments: { bytes: 256 },
        },
        capacity: {
            storage: { scope: "origin" as const, usedBytes: 4096, limitBytes: 8192, availableBytes: 4096 },
        },
    };
    const objectTypes = [
        {
            name: "Issue",
            displayName: "Issue",
            pluralDisplayName: "Issues",
            primaryKey: "id",
            properties: [],
            color: "#123456",
        },
    ];
    const html = renderToStaticMarkup(<StorageDetails status={status} objectTypes={objectTypes} />);
    expect(html).toContain("Issues");
    expect(html).toContain("#123456");
    expect(html).not.toContain("Reclaim toward");
    expect(html).not.toContain("Attachments budget");
    expect(html).not.toContain("Browser origin estimate");
    const capacity = renderToStaticMarkup(
        <StorageDetails status={status} objectTypes={objectTypes} view="available" />
    );
    expect(capacity).toContain("Issues");
    expect(capacity).toContain("#123456");
    expect(capacity).toContain("shared free quota");
    expect(capacity).toContain("4 KiB available");
    expect(capacity).not.toContain("Other storage");
    expect(capacity).not.toContain("NaN");
    const objects = renderToStaticMarkup(
        <StorageDetails status={status} objectTypes={objectTypes} view="objects" />
    );
    expect(objects).toContain("512 B");
    expect(objects).toContain("Above budget");
    expect(objects).not.toContain("Attachments");
});

test("unknown platform usage does not invent free space or budgets", () => {
    const html = renderToStaticMarkup(
        <StorageDetails
            status={{
                cache: { objects: { bytes: 1 }, attachments: { bytes: 0 } },
                capacity: { memory: { scope: "isolate", limitBytes: 128 * 1024 * 1024 } },
            }}
            view="available"
        />
    );
    expect(html).not.toContain("128 MiB");
    expect(html).not.toContain("0 B available");
    expect(html).not.toContain("budget");
});
