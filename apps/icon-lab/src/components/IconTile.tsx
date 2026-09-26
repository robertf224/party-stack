import { useEffect, useState } from "react";
import type { CatalogIcon } from "../shared/types";
import { getIconAssetUrl } from "../shared/iconArchives";

export function IconTile({ icon, size = 48 }: { icon: CatalogIcon; size?: number }) {
    const [assetUrl, setAssetUrl] = useState<string>();

    useEffect(() => {
        let cancelled = false;
        setAssetUrl(undefined);
        getIconAssetUrl(icon)
            .then((url) => {
                if (!cancelled) {
                    setAssetUrl(url);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setAssetUrl(undefined);
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
                <img
                    src={assetUrl}
                    alt={icon.name}
                    width={size}
                    height={size}
                    className="object-contain"
                />
            </div>
        );
    }

    return (
        <div
            className="flex items-center justify-center rounded-lg border border-dashed border-[var(--line)] bg-[#f8fafc] px-2 text-center"
            style={{ width: size + 24, height: size + 24 }}
        >
            <span className="font-[var(--font-mono)] text-[10px] leading-tight text-[var(--muted)]">
                {icon.name}
            </span>
        </div>
    );
}
