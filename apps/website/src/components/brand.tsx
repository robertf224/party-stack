import { PartyStackLogomark } from "@party-stack/design-system/brand";

export function Brand() {
    return (
        <span className="brand">
            <PartyStackLogomark style={{ width: 34, height: 34 }} />
            <span>Party Stack</span>
        </span>
    );
}
