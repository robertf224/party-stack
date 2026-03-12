import type { Deprecation } from "../../ir/index.js";
import type { OptionalKind, JSDocStructure } from "ts-morph";

export function buildJsDocs(opts: {
    description?: string;
    deprecated?: Deprecation;
}): OptionalKind<JSDocStructure>[] | undefined {
    const { description, deprecated } = opts;
    if (!description && !deprecated) return undefined;

    return [
        {
            description,
            tags: deprecated ? [{ tagName: "deprecated", text: deprecated.message }] : undefined,
        },
    ];
}
