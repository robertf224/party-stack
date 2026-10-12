import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { getExpoSymbol } from "./index.js";
import type { IconName } from "@party-stack/icons";

export interface ExpoIconProps extends Omit<SymbolViewProps, "name"> {
    name: IconName;
}

/** Renders only the native iOS and Android mappings. */
export function ExpoIcon({ name, ...props }: ExpoIconProps) {
    return <SymbolView name={getExpoSymbol(name)} {...props} />;
}
