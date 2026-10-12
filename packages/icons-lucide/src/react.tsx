import { DynamicIcon } from "lucide-react/dynamic";
import { getLucideIconName } from "./index.js";
import type { IconName } from "@party-stack/icons";
import type { ComponentProps } from "react";

export interface LucideIconProps extends Omit<ComponentProps<typeof DynamicIcon>, "name"> {
    name: IconName;
}

/**
 * React renderer backed by Lucide's dynamic per-icon imports.
 *
 * This creates one chunk per Lucide asset instead of eagerly bundling the full
 * set, which fits ontology icons whose names are only known at runtime.
 */
export function LucideIcon({ name, ...props }: LucideIconProps) {
    return <DynamicIcon name={getLucideIconName(name)} {...props} />;
}
