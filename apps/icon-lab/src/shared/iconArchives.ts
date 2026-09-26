import { strFromU8, unzipSync } from "fflate";
import type { CatalogIcon } from "./types";

const archives = new Map<string, Promise<Record<string, Uint8Array>>>();
const objectUrls = new Map<string, string>();

async function loadArchive(path: string): Promise<Record<string, Uint8Array>> {
    let pending = archives.get(path);
    if (!pending) {
        const url = path === "sfsymbols.local.zip" ? `/generated-data/${path}` : `/icon-sets/${path}`;
        pending = fetch(url)
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`Failed to load ${path}: ${response.status}`);
                }
                return response.arrayBuffer();
            })
            .then((buffer) => unzipSync(new Uint8Array(buffer)));
        archives.set(path, pending);
    }
    return pending;
}

export async function getIconAssetUrl(icon: CatalogIcon): Promise<string | undefined> {
    if (!icon.asset) {
        return undefined;
    }
    const cached = objectUrls.get(icon.id);
    if (cached) {
        return cached;
    }
    const archive = await loadArchive(icon.asset.archive);
    const bytes = archive[icon.asset.path];
    if (!bytes) {
        throw new Error(`Missing ${icon.asset.path} in ${icon.asset.archive}`);
    }
    const mime = icon.asset.format === "svg" ? "image/svg+xml" : "image/png";
    const source =
        icon.provider === "salesforce" && icon.asset.format === "svg"
            ? strFromU8(bytes)
                  .replaceAll('fill="#fff"', 'fill="#16324f"')
                  .replaceAll('fill="#ffffff"', 'fill="#16324f"')
            : new Uint8Array(bytes);
    const url = URL.createObjectURL(new Blob([source], { type: mime }));
    objectUrls.set(icon.id, url);
    return url;
}
