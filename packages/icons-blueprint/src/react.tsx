import { Icon, type IconProps } from "@blueprintjs/core";
import { getBlueprintIconName } from "./index.js";
import type { IconName } from "@party-stack/icons";

export interface BlueprintIconProps extends Omit<IconProps, "icon"> {
    name: IconName;
}

export function BlueprintIcon({ name, ...props }: BlueprintIconProps) {
    return <Icon icon={getBlueprintIconName(name)} {...props} />;
}
