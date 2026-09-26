import { Icon, type IconProps } from "@blueprintjs/core";
import type { IconName } from "@party-stack/icons";
import { getBlueprintIconName } from "./index.js";

export interface BlueprintIconProps extends Omit<IconProps, "icon"> {
    name: IconName;
}

export function BlueprintIcon({ name, ...props }: BlueprintIconProps) {
    return <Icon icon={getBlueprintIconName(name)} {...props} />;
}
