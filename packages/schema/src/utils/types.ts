import { TypeDef } from "../ir/generated/types.js";

export function unwrapType(type: TypeDef): { type: TypeDef; isOptional: boolean } {
    if (type.kind === "optional") {
        return { type: type.value.type, isOptional: true };
    }
    return { type, isOptional: false };
}
