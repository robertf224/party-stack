import { LucideIcon } from "@party-stack/icons-lucide/react";
import type { IconName } from "@party-stack/icons";
import type { ObjectTypeDef } from "@party-stack/ontology";

export function OntologyIcon({
    className,
    color,
    name,
}: {
    className?: string;
    color?: string;
    name: IconName;
}) {
    return (
        <LucideIcon
            aria-hidden="true"
            className={className}
            name={name}
            style={color ? { color } : undefined}
        />
    );
}
export function ObjectTypeIcon({ className, objectType }: { className?: string; objectType: ObjectTypeDef }) {
    return (
        <OntologyIcon
            className={className}
            color={objectType.color}
            name={objectType.icon?.name ?? "database"}
        />
    );
}
