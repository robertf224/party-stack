import type { DemandOwner } from "./attribution/registry.js";

export function QueryOwners({ owners }: { owners: readonly DemandOwner[] }) {
    if (!owners.length) return null;
    const groups = new Map<string, { owner: DemandOwner; count: number }>();
    for (const owner of owners) {
        const key = JSON.stringify([owner.name, owner.source]);
        const group = groups.get(key);
        if (group) group.count++;
        else groups.set(key, { owner, count: 1 });
    }
    const shown = [...groups.values()].slice(0, 3);
    const remaining = owners.length - shown.reduce((total, group) => total + group.count, 0);
    return (
        <span
            className="ps-query-owners"
            aria-label={`${owners.length} ${owners.length === 1 ? "component" : "components"}`}
            title="Hover to highlight · click to scroll to components"
        >
            <span className="ps-query-owner-label">Components</span>
            {shown.map(({ owner, count }) => (
                <span className="ps-query-owner-name" key={owner.id} title={owner.source}>
                    {owner.name}
                    {count > 1 && ` ×${count}`}
                </span>
            ))}
            {remaining > 0 && (
                <span className="ps-query-owner-more">
                    and {remaining} other {remaining === 1 ? "component" : "components"}
                </span>
            )}
        </span>
    );
}
