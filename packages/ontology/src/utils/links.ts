import type { LinkTypeDef, OntologyIR } from "../ir/index.js";
import type { ArrayElement, ObjectTypeName } from "./typeNames.js";

type LinkTypes<IR extends Pick<OntologyIR, "linkTypes">> = ArrayElement<IR["linkTypes"]>;

type LinkHopNameForLink<Link, SourceObjectType extends string> = Link extends {
    source: {
        objectType: infer LinkSourceObjectType extends string;
    };
    target: {
        objectType: infer LinkTargetObjectType extends string;
        name: infer TargetName extends string;
    };
}
    ? SourceObjectType extends LinkSourceObjectType
        ? TargetName
        : SourceObjectType extends LinkTargetObjectType
          ? Link extends {
                source: {
                    name: infer SourceName extends string;
                };
            }
              ? SourceName
              : never
          : never
    : never;

export type LinkHopName<
    IR extends Pick<OntologyIR, "linkTypes">,
    SourceObjectType extends string,
> = LinkHopNameForLink<LinkTypes<IR>, SourceObjectType>;

type LinkHopTargetForLink<Link, SourceObjectType extends string, Name extends string> = Link extends {
    source: {
        objectType: infer LinkSourceObjectType extends string;
        name: infer SourceName extends string;
    };
    target: {
        objectType: infer TargetObjectType extends string;
        name: infer TargetName extends string;
    };
}
    ? SourceObjectType extends LinkSourceObjectType
        ? Name extends TargetName
            ? TargetObjectType
            : never
        : Link extends {
                target: {
                    objectType: infer LinkTargetObjectType extends string;
                };
            }
          ? SourceObjectType extends LinkTargetObjectType
              ? Name extends SourceName
                  ? LinkSourceObjectType
                  : never
              : never
          : never
    : never;

export type LinkHopTargetObjectType<
    IR extends Pick<OntologyIR, "linkTypes">,
    SourceObjectType extends string,
    Name extends string,
> = LinkHopTargetForLink<LinkTypes<IR>, SourceObjectType, Name>;

type LinkHopLinkForLink<Link, SourceObjectType extends string, Name extends string> = Link extends {
    source: {
        objectType: infer LinkSourceObjectType extends string;
        name: infer SourceName extends string;
    };
    target: {
        objectType: infer LinkTargetObjectType extends string;
        name: infer TargetName extends string;
    };
}
    ? SourceObjectType extends LinkSourceObjectType
        ? Name extends TargetName
            ? Link
            : never
        : SourceObjectType extends LinkTargetObjectType
          ? Name extends SourceName
              ? Link
              : never
          : never
    : never;

export type LinkHopLink<
    IR extends Pick<OntologyIR, "linkTypes">,
    SourceObjectType extends string,
    Name extends string,
> = LinkHopLinkForLink<LinkTypes<IR>, SourceObjectType, Name>;

export function isLinkHopFromForeignKeySource(
    link: LinkTypeDef,
    sourceObjectType: string,
    linkName: string
): boolean {
    return link.source.objectType === sourceObjectType && link.target.name === linkName;
}

export function resolveLinkHop<
    const IR extends Pick<OntologyIR, "linkTypes" | "objectTypes">,
    const SourceObjectType extends ObjectTypeName<IR>,
    const Name extends LinkHopName<IR, SourceObjectType>,
>(
    ir: IR,
    sourceObjectType: SourceObjectType,
    linkName: Name
): LinkHopLink<IR, SourceObjectType, Name> | undefined {
    const matches = ir.linkTypes.flatMap((link) => [
        ...(isLinkHopFromForeignKeySource(link, sourceObjectType, linkName) ? [link] : []),
        ...(link.target.objectType === sourceObjectType && link.source.name === linkName ? [link] : []),
    ]);
    if (matches.length !== 1) return undefined;
    return matches[0] as LinkHopLink<IR, SourceObjectType, Name>;
}
