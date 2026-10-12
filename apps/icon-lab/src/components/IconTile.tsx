import { useEffect, useState } from "react";
import { getIconAssetUrl } from "../shared/iconArchives";
import type { CatalogIcon } from "../shared/types";

export function IconTile({ icon, size = 48 }: { icon: CatalogIcon; size?: number }) {
    const [asset, setAsset] = useState<{ icon: CatalogIcon; url?: string }>();
    const assetUrl = asset?.icon === icon ? asset.url : undefined;

    useEffect(() => {
        let cancelled = false;
        getIconAssetUrl(icon)
            .then((url) => {
                if (!cancelled) {
                    setAsset({ icon, url });
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setAsset({ icon });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [icon]);

    if (assetUrl) {
        return (
            <div
                className="flex items-center justify-center rounded-lg bg-[#f8fafc]"
                style={{ width: size + 24, height: size + 24 }}
            >
                <img src={assetUrl} alt={icon.name} width={size} height={size} className="object-contain" />
            </div>
        );
    }

    return (
        <div
            className="flex items-center justify-center rounded-lg border border-dashed border-[var(--line)] bg-[#f8fafc] px-2 text-center"
            style={{ width: size + 24, height: size + 24 }}
        >
            <span className="text-[10px] leading-tight font-[var(--font-mono)] text-[var(--muted)]">
                {icon.name}
            </span>
        </div>
    );
}
