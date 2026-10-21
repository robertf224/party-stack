import type { LinkTypeDef, OntologyIR } from "../ir/index.js";
import type { ArrayElement, ObjectTypeName } from "./typeNames.js";

type LinkTypes<IR extends Pick<OntologyIR, "linkTypes">> = ArrayElement<IR["linkTypes"]>;

type RelatedNameForLink<Link, SourceObjectType extends string> = Link extends {
    source: { objectType: infer Source extends string; name: infer SourceName extends string };
    target: { objectType: infer Target extends string; name: infer TargetName extends string };
}
    ?
          | (SourceObjectType extends Source ? TargetName : never)
          | (SourceObjectType extends Target ? SourceName : never)
    : never;

export type RelatedName<
    IR extends Pick<OntologyIR, "linkTypes">,
    SourceObjectType extends string,
> = RelatedNameForLink<LinkTypes<IR>, SourceObjectType>;

type RelatedTargetForLink<Link, SourceObjectType extends string, Name extends string> = Link extends {
    source: { objectType: infer Source extends string; name: infer SourceName extends string };
    target: { objectType: infer Target extends string; name: infer TargetName extends string };
}
    ?
          | (SourceObjectType extends Source ? (Name extends TargetName ? Target : never) : never)
          | (SourceObjectType extends Target ? (Name extends SourceName ? Source : never) : never)
    : never;

export type RelatedTargetObjectType<
    IR extends Pick<OntologyIR, "linkTypes">,
    SourceObjectType extends string,
    Name extends string,
> = RelatedTargetForLink<LinkTypes<IR>, SourceObjectType, Name>;

type RelatedLinkForLink<Link, SourceObjectType extends string, Name extends string> = Link extends {
    source: { objectType: infer Source extends string; name: infer SourceName extends string };
    target: { objectType: infer Target extends string; name: infer TargetName extends string };
}
    ?
          | (SourceObjectType extends Source ? (Name extends TargetName ? Link : never) : never)
          | (SourceObjectType extends Target ? (Name extends SourceName ? Link : never) : never)
    : never;

export type RelatedLink<
    IR extends Pick<OntologyIR, "linkTypes">,
    SourceObjectType extends string,
    Name extends string,
> = RelatedLinkForLink<LinkTypes<IR>, SourceObjectType, Name>;

export function isRelatedFromForeignKeySource(
    link: LinkTypeDef,
    sourceObjectType: string,
    linkName: string
): boolean {
    return link.source.objectType === sourceObjectType && link.target.name === linkName;
}

export function resolveRelatedLink<
    const IR extends Pick<OntologyIR, "linkTypes" | "objectTypes">,
    const SourceObjectType extends ObjectTypeName<IR>,
    const Name extends RelatedName<IR, SourceObjectType>,
>(
    ir: IR,
    sourceObjectType: SourceObjectType,
    linkName: Name
): RelatedLink<IR, SourceObjectType, Name> | undefined {
    const matches = ir.linkTypes.flatMap((link) => [
        ...(isRelatedFromForeignKeySource(link, sourceObjectType, linkName) ? [link] : []),
        ...(link.target.objectType === sourceObjectType && link.source.name === linkName ? [link] : []),
    ]);
    if (matches.length !== 1) return undefined;
    return matches[0] as RelatedLink<IR, SourceObjectType, Name>;
}
